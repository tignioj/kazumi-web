import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'package:kazumi/request/core/network_config.dart';

/// Keeps upstream's proxy certificate policy while using our mandatory egress.
/// Each request owns a client so relaxed TLS connections cannot be reused by a
/// later direct request or by another source searched concurrently.
class ProxyHttpAdapter implements HttpClientAdapter {
  ProxyHttpAdapter(this.egress);

  final Uri egress;
  final HttpClient _policyClient = HttpClient()
    ..connectionTimeout = const Duration(seconds: 3);
  final Set<IOHttpClientAdapter> _active = {};
  bool _closed = false;

  String _key(String host, int port) => '${host.toLowerCase()}:$port';

  Future<bool> _allowBadCertificates(Uri target) async {
    final policy = egress.replace(
      path: '/_kazumi/tls-policy',
      queryParameters: {'url': target.toString()},
    );
    return (() async {
      final request = await _policyClient.getUrl(policy);
      request.followRedirects = false;
      final response = await request.close();
      if (response.statusCode != HttpStatus.ok) {
        await response.drain<void>();
        throw HttpException('Egress TLS policy unavailable', uri: policy);
      }
      final value = jsonDecode(await utf8.decoder.bind(response).join());
      if (value is! Map || value['allowBadCertificates'] is! bool) {
        throw const FormatException('Invalid egress TLS policy');
      }
      return value['allowBadCertificates'] as bool;
    })().timeout(const Duration(seconds: 3));
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (_closed) throw StateError('HTTP adapter is closed');
    final decisions = <String, bool>{};
    final adapter = NetworkConfig(
      proxyHost: egress.host,
      proxyPort: egress.port,
    ).createAdapter();
    final createClient = adapter.createHttpClient!;
    adapter.createHttpClient = () {
      final client = createClient();
      client.badCertificateCallback = (certificate, host, port) =>
          decisions[_key(host, port)] == true;
      // Runs for each connection, including hosts reached through redirects.
      client.connectionFactory = (uri, proxyHost, proxyPort) async {
        decisions[_key(uri.host, uri.port)] = await _allowBadCertificates(uri);
        return Socket.startConnect(
          proxyHost ?? uri.host,
          proxyPort ?? uri.port,
        );
      };
      return client;
    };
    _active.add(adapter);
    try {
      final response = await adapter.fetch(
        options,
        requestStream,
        cancelFuture,
      );
      response.stream = _release(response.stream, adapter);
      return response;
    } catch (_) {
      _active.remove(adapter);
      adapter.close(force: true);
      rethrow;
    }
  }

  Stream<Uint8List> _release(
    Stream<Uint8List> stream,
    IOHttpClientAdapter adapter,
  ) async* {
    try {
      yield* stream;
    } finally {
      _active.remove(adapter);
      adapter.close();
    }
  }

  @override
  void close({bool force = false}) {
    _closed = true;
    for (final adapter in _active) {
      adapter.close(force: force);
    }
    _active.clear();
    _policyClient.close(force: force);
  }
}
