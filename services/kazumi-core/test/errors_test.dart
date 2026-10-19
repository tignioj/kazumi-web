import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/request/core/network_exception.dart';
import 'package:kazumi/services/plugin/rule_engine_models.dart';
import 'package:kazumi_core/errors.dart';

void main() {
  const owner = 'AGE:private-cookie-jar-owner';

  test(
    'unknown Dio handshake errors retain the certificate failure category',
    () {
      final error = SearchErrorException(
        owner,
        cause: NetworkException(
          type: NetworkExceptionType.unknown,
          message: '网络异常',
          rawError: DioException(
            requestOptions: RequestOptions(path: 'https://example.com/private'),
            error: const HandshakeException(
              'Handshake error',
              OSError(
                'CERTIFICATE_VERIFY_FAILED: unable to get local issuer',
                0,
              ),
            ),
          ),
        ),
      );
      final result = ruleFailure(error)!;
      expect(result['code'], 'SOURCE_CERTIFICATE_ERROR');
      expect(result['error'], contains('证书校验失败'));
      expect(result.toString(), isNot(contains(owner)));
      expect(result.toString(), isNot(contains('/private')));
      expect(result.toString(), isNot(contains('SearchErrorException')));
    },
  );

  test('transport categories survive both search and chapter wrappers', () {
    const categories = {
      NetworkExceptionType.badCertificate: 'SOURCE_CERTIFICATE_ERROR',
      NetworkExceptionType.connectionError: 'SOURCE_CONNECTION_ERROR',
      NetworkExceptionType.connectionTimeout: 'SOURCE_CONNECT_TIMEOUT',
      NetworkExceptionType.receiveTimeout: 'SOURCE_TIMEOUT',
      NetworkExceptionType.sendTimeout: 'SOURCE_TIMEOUT',
      NetworkExceptionType.badResponse: 'SOURCE_HTTP_ERROR',
      NetworkExceptionType.cancel: 'SOURCE_CANCELLED',
      NetworkExceptionType.parseError: 'SOURCE_RULE_ERROR',
      NetworkExceptionType.unknown: 'SOURCE_NETWORK_ERROR',
    };
    for (final entry in categories.entries) {
      final cause = NetworkException(
        type: entry.key,
        message: 'raw failure containing private details',
        statusCode: 522,
      );
      for (final error in [
        SearchErrorException(owner, cause: cause),
        ChapterErrorException(owner, cause: cause),
      ]) {
        final result = ruleFailure(error)!;
        expect(result['code'], entry.value);
        expect(result.toString(), isNot(contains('private')));
        if (entry.key == NetworkExceptionType.badResponse) {
          expect(result['error'], contains('HTTP 522'));
        }
      }
    }
  });

  test('TLS protocol failures differ from certificate failures', () {
    final result = ruleFailure(
      const SearchErrorException(
        owner,
        cause: NetworkException(
          type: NetworkExceptionType.unknown,
          message: '网络异常',
          rawError: HandshakeException('WRONG_VERSION_NUMBER'),
        ),
      ),
    );
    expect(result!['code'], 'SOURCE_TLS_ERROR');
  });

  test(
    'rule failures hide raw parsing errors without intercepting captcha or no-result',
    () {
      final result = ruleFailure(
        SearchErrorException(owner, cause: StateError('private response body')),
      );
      expect(result!['code'], 'SOURCE_RULE_ERROR');
      expect(result.toString(), isNot(contains('private')));
      expect(ruleFailure(const NoResultException(owner)), isNull);
      expect(ruleFailure(const CaptchaRequiredException(owner)), isNull);
      expect(ruleFailure(const FormatException('invalid request')), isNull);
    },
  );
}
