import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi_core/proxy_http_adapter.dart';

void main() {
  late HttpServer origin;
  late HttpServer proxy;
  late Dio dio;
  final sockets = <Socket>{};
  final checkedHosts = <String>[];
  var enabled = false;
  var policyStatus = 200;

  setUp(() async {
    enabled = false;
    policyStatus = 200;
    checkedHosts.clear();
    final context = SecurityContext()
      ..useCertificateChain('test/fixtures/localhost-cert.pem')
      ..usePrivateKey('test/fixtures/localhost-key.pem');
    origin = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      context,
    );
    origin.listen((request) {
      if (request.uri.path == '/redirect') {
        request.response
          ..statusCode = 302
          ..headers.set(
            HttpHeaders.locationHeader,
            'https://127.0.0.1:${origin.port}/done',
          );
      } else {
        request.response.write('proxied TLS');
      }
      request.response.close();
    });
    proxy = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    proxy.listen((request) async {
      if (request.uri.path == '/_kazumi/tls-policy') {
        final target = Uri.parse(request.uri.queryParameters['url']!);
        checkedHosts.add(target.host);
        request.response
          ..statusCode = policyStatus
          ..write(
            jsonEncode({
              'allowBadCertificates': enabled && target.host == 'localhost',
            }),
          );
        await request.response.close();
        return;
      }
      if (request.method != 'CONNECT') {
        request.response.statusCode = 400;
        await request.response.close();
        return;
      }
      final remote = await Socket.connect(
        InternetAddress.loopbackIPv4,
        origin.port,
      );
      final client = await request.response.detachSocket(writeHeaders: false);
      sockets.addAll([remote, client]);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      remote.listen(
        client.add,
        onError: (Object _) => client.destroy(),
        onDone: client.destroy,
      );
      client.listen(
        remote.add,
        onError: (Object _) => remote.destroy(),
        onDone: remote.destroy,
      );
    });
    dio =
        Dio(
            BaseOptions(
              connectTimeout: const Duration(seconds: 5),
              receiveTimeout: const Duration(seconds: 5),
              responseType: ResponseType.plain,
            ),
          )
          ..httpClientAdapter = ProxyHttpAdapter(
            Uri.parse('http://127.0.0.1:${proxy.port}'),
          );
  });

  tearDown(() async {
    dio.close(force: true);
    for (final socket in sockets) {
      socket.destroy();
    }
    sockets.clear();
    await proxy.close(force: true);
    await origin.close(force: true);
  });

  test('only enabled proxy routes accept bad certificates', () async {
    final url = 'https://localhost:${origin.port}/';
    await expectLater(dio.get<String>(url), throwsA(isA<DioException>()));
    enabled = true;
    expect((await dio.get<String>(url)).data, 'proxied TLS');
    enabled = false;
    await expectLater(dio.get<String>(url), throwsA(isA<DioException>()));
    expect(checkedHosts, ['localhost', 'localhost', 'localhost']);
  });

  test('redirected direct targets still verify certificates', () async {
    enabled = true;
    await expectLater(
      dio.get<String>('https://localhost:${origin.port}/redirect'),
      throwsA(isA<DioException>()),
    );
    expect(checkedHosts, ['localhost', '127.0.0.1']);
  });

  test(
    'concurrent direct and proxy requests do not share TLS permissions',
    () async {
      enabled = true;
      final relaxed = dio.get<String>('https://localhost:${origin.port}/');
      final strict = expectLater(
        dio.get<String>('https://127.0.0.1:${origin.port}/'),
        throwsA(isA<DioException>()),
      );
      expect((await relaxed).data, 'proxied TLS');
      await strict;
      expect(checkedHosts.toSet(), {'localhost', '127.0.0.1'});
    },
  );

  test('unavailable route policy never enables a certificate bypass', () async {
    enabled = true;
    policyStatus = 502;
    await expectLater(
      dio.get<String>('https://localhost:${origin.port}/'),
      throwsA(isA<DioException>()),
    );
  });
}
