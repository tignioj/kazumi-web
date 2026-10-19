import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:hive_ce_flutter/hive_flutter.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/video_source/video_source_service.dart';
import 'package:kazumi/services/plugin/rule_engine_models.dart';
import 'package:kazumi/request/core/dio_factory.dart';
import 'package:kazumi/request/core/network_config.dart';
import 'package:path_provider/path_provider.dart';
import 'package:window_manager/window_manager.dart';

import 'core.dart';
import 'errors.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  runApp(const SizedBox.shrink());
  await windowManager.hide();
  final directory = await getApplicationSupportDirectory();
  await Hive.initFlutter('${directory.path}/hive');
  await GStorage.init();
  final proxy = Platform.environment['KAZUMI_EGRESS_PROXY'];
  if (proxy == null || !proxy.startsWith('http://')) {
    throw StateError(
      'KAZUMI_EGRESS_PROXY must point at the Web server egress proxy',
    );
  }
  await GStorage.putSetting(SettingsKeys.proxyEnable, true);
  await GStorage.putSetting(SettingsKeys.proxyUrl, proxy);
  // This CONNECT proxy leaves TLS end-to-end; retain certificate verification.
  final endpoint = Uri.parse(proxy);
  final dio = DioFactory.pluginDio;
  dio.httpClientAdapter.close(force: true);
  dio.httpClientAdapter = NetworkConfig(
    proxyHost: endpoint.host,
    proxyPort: endpoint.port,
    allowBadCertificates: false,
  ).createAdapter();
  final core = KazumiCore();
  final server = await HttpServer.bind(
    Platform.environment['HOST'] ?? '0.0.0.0',
    int.parse(Platform.environment['PORT'] ?? '7331'),
  );
  stdout.writeln('Kazumi core $upstreamRevision listening on ${server.port}');
  await for (final request in server) {
    () async {
      try {
        request.response.headers.contentType = ContentType.json;
        if (request.method != 'POST' && request.uri.path != '/health') {
          request.response.statusCode = 405;
          request.response.write('{"error":"Method not allowed"}');
          return;
        }
        var size = 0;
        final bytes = <int>[];
        await for (final chunk in request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            throw const FormatException('Request too large');
          }
          bytes.addAll(chunk);
        }
        final body = bytes.isEmpty
            ? <String, dynamic>{}
            : Map<String, dynamic>.from(jsonDecode(utf8.decode(bytes)) as Map);
        final result = await core.execute(request.uri.path, body);
        request.response.write(jsonEncode(result));
      } on CaptchaRequiredException {
        request.response.statusCode = 423;
        request.response.write(
          '{"error":"需要完成来源验证","code":"CAPTCHA_REQUIRED"}',
        );
      } on NoResultException {
        request.response.write('{"items":[]}');
      } on VideoSourceTimeoutException {
        request.response.statusCode = 504;
        request.response.write('{"error":"原版 Kazumi 视频解析超时"}');
      } catch (e, stack) {
        stderr.writeln('$e\n$stack');
        request.response.statusCode = e is FormatException || e is TypeError
            ? 400
            : 502;
        request.response.write(
          jsonEncode(ruleFailure(e) ?? {'error': e.toString()}),
        );
      } finally {
        try {
          await request.response.close();
        } on IOException {
          // The Node caller may have cancelled and closed its socket.
        } on StateError {
          // An already-closed response must not terminate the Flutter host.
        }
      }
    }();
  }
  await core.close();
}
