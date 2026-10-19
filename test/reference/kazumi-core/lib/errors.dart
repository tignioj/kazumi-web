import 'dart:io';

import 'package:dio/dio.dart';
import 'package:kazumi/request/core/network_exception.dart';
import 'package:kazumi/services/plugin/rule_engine_models.dart';

/// Translate typed upstream failures at the HTTP boundary. Keep raw exceptions,
/// including the cookie-jar owner appended to plugin names, in server logs.
Map<String, String>? ruleFailure(Object error) {
  final Object? cause;
  if (error is SearchErrorException) {
    cause = error.cause;
  } else if (error is ChapterErrorException) {
    cause = error.cause;
  } else {
    return null;
  }

  String code = 'SOURCE_RULE_ERROR';
  String message = '来源规则解析失败，请更新规则或更换片源';
  if (cause is NetworkException) {
    final raw = cause.rawError;
    final transport = raw is DioException ? raw.error : raw;
    // Dart IO reports certificate verification failures as unknown Dio errors.
    // Preserve that distinction without exposing URLs, credentials or headers.
    final certificateFailure =
        cause.type == NetworkExceptionType.badCertificate ||
        (transport is HandshakeException &&
            transport.toString().contains('CERTIFICATE_VERIFY_FAILED'));
    if (certificateFailure) {
      code = 'SOURCE_CERTIFICATE_ERROR';
      message = '来源站点证书校验失败，请检查站点证书或视频代理设置';
    } else if (transport is HandshakeException) {
      code = 'SOURCE_TLS_ERROR';
      message = '来源站点 TLS 握手失败，请检查站点或视频代理设置';
    } else {
      switch (cause.type) {
        case NetworkExceptionType.connectionError:
          code = 'SOURCE_CONNECTION_ERROR';
          message = '来源连接中断，请重试或检查视频代理设置';
        case NetworkExceptionType.connectionTimeout:
          code = 'SOURCE_CONNECT_TIMEOUT';
          message = '连接来源站点超时，请稍后重试或检查视频代理设置';
        case NetworkExceptionType.receiveTimeout:
        case NetworkExceptionType.sendTimeout:
          code = 'SOURCE_TIMEOUT';
          message = '来源站点响应超时，请稍后重试或更换片源';
        case NetworkExceptionType.badResponse:
          code = 'SOURCE_HTTP_ERROR';
          message = cause.statusCode == null
              ? '来源站点返回错误，请稍后重试或更换片源'
              : '来源站点返回 HTTP ${cause.statusCode}，请稍后重试或更换片源';
        case NetworkExceptionType.cancel:
          code = 'SOURCE_CANCELLED';
          message = '片源请求已取消';
        case NetworkExceptionType.parseError:
          break;
        case NetworkExceptionType.badCertificate:
        case NetworkExceptionType.unknown:
          code = 'SOURCE_NETWORK_ERROR';
          message = '无法连接来源站点，请检查站点或视频代理设置';
      }
    }
  }
  return {'error': message, 'code': code};
}
