import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/services/plugin/rule_engine.dart';
import 'package:kazumi/services/plugin/rule_engine_models.dart';
import 'package:dio/dio.dart';
import 'package:kazumi_core/core.dart';
import 'package:kazumi/webview/captcha/captcha_webview_controller.dart';

class FakeCaptcha extends CaptchaWebviewController<Object> {
  FakeCaptcha(this.onInit);
  final void Function() onInit;
  @override
  Future<void> init() async {
    onInit();
  }

  @override
  Future<void> loadPage(
    String url,
    String captchaXpath, {
    String? inputXpath,
  }) async {}
  @override
  Future<void> loadPageForButtonClick(String url, String buttonXpath) async {}
  @override
  Future<void> loadPageForCustomScript(String url, String script) async {}
  @override
  Future<void> submitCaptchaInteract(
    String code,
    String input,
    String button,
  ) async {}
  @override
  Future<String> getCookieString(String url) async => '';
  @override
  Future<String> getPageHtml() async => '';
  @override
  Future<String> getUserAgent() async => 'Fixture';
  @override
  Future<void> unloadPage() async {}
  @override
  void dispose() {
    captchaImageFoundController.close();
    captchaDisappearedController.close();
    initEventController.close();
    logEventController.close();
  }
}

class FixtureRequests implements RuleRequestExecutor {
  PreparedRuleRequest? last;
  @override
  Future<String> execute(
    PreparedRuleRequest request,
    RuleExecutionConfig config, {
    CancelToken? cancelToken,
  }) async {
    last = request;
    if (request.url.contains('/search')) {
      return '<article><a href="/series/7">番剧</a></article>';
    }
    if (request.url.contains('/api')) {
      return '{"data":[{"name":"API 番剧","id":"a/b"}]}';
    }
    return '<ul><li><a href="/watch/1">第1集</a></li></ul>';
  }
}

final xpathRule = <String, dynamic>{
  'name': 'Fixture',
  'api': '9',
  'baseURL': 'https://example.com',
  'searchURL': 'https://example.com/search?q=@keyword',
  'searchList': '//article',
  'searchName': '//a',
  'searchResult': '//a',
  'chapterRoads': '//ul',
  'chapterResult': '//a',
};

void main() {
  test(
    'waiting native resolutions can be cancelled while the pool is busy',
    () async {
      final core = KazumiCore();
      addTearDown(core.close);
      final first = core.resolvers.tryAcquire('first')!;
      final second = core.resolvers.tryAcquire('second')!;
      final pending = core.execute('/resolve', {
        'rule': xpathRule,
        'requestId': 'waiting',
        'url': 'https://example.com/watch',
      });
      final cancelled = expectLater(pending, throwsA(isA<DioException>()));
      await core.execute('/cancel', {'requestId': 'waiting'});
      await cancelled;
      core.resolvers.release(first);
      core.resolvers.release(second);
    },
  );

  test(
    'cancelling a queued captcha cannot bypass the active native session',
    () async {
      final initialized = <int>[];
      var count = 0;
      final core = KazumiCore(
        captchaFactory: () {
          final number = ++count;
          return FakeCaptcha(() => initialized.add(number));
        },
      );
      addTearDown(core.close);
      final first = await core.execute('/captcha/start', {
        'rule': xpathRule,
        'keyword': 'a b',
      });
      final second = await core.execute('/captcha/start', {
        'rule': xpathRule,
        'keyword': 'a b',
      });
      await core.execute('/captcha/cancel', {'id': second['id']});
      await core.execute('/captcha/start', {
        'rule': xpathRule,
        'keyword': 'a b',
      });
      await Future<void>.delayed(Duration.zero);
      expect(initialized, [1]);
      await core.execute('/captcha/cancel', {'id': first['id']});
      await Future<void>.delayed(Duration.zero);
      expect(initialized, [1, 3]);
      expect(first['url'], contains('a+b'));
    },
  );
  test(
    'HTTP shapes are backed by the real upstream XPath implementation',
    () async {
      final requests = FixtureRequests();
      final core = KazumiCore(
        engine: RuleEngine(requestExecutor: requests, logFailures: false),
      );
      addTearDown(core.close);
      final search = await core.execute('/search', {
        'rule': xpathRule,
        'requestId': 'search',
        'keyword': '测试',
      });
      final items = search['items'] as List;
      expect(items.single['name'], '番剧');
      expect(items.single['url'], isNotEmpty);
      expect(requests.last!.url, contains(Uri.encodeQueryComponent('测试')));
      final chapters = await core.execute('/chapters', {
        'rule': xpathRule,
        'requestId': 'chapters',
        'url': '/series/7',
      });
      expect(
        (chapters['roads'] as List).single['episodes'].single['url'],
        'https://example.com/watch/1',
      );
    },
  );

  test(
    'API 9 templates and opaque source IDs stay under upstream control',
    () async {
      final core = KazumiCore(
        engine: RuleEngine(
          requestExecutor: FixtureRequests(),
          logFailures: false,
        ),
      );
      addTearDown(core.close);
      final rule = {
        ...xpathRule,
        'searchMode': 'api',
        'searchApiConfig': {
          'request': {'url': 'https://example.com/api', 'method': 'GET'},
          'listPath': r'$.data[*]',
          'namePath': r'$.name',
          'sourcePath': r'$.id',
          'sourceTemplate': 'https://example.com/GV@source/',
        },
      };
      final result = await core.execute('/search', {
        'rule': rule,
        'requestId': 'api',
        'keyword': '番剧',
      });
      expect(
        (result['items'] as List).single['url'],
        'https://example.com/GVa%2Fb/',
      );
      final imported = core.importRules({
        ...rule,
        'enabled': false,
        'author': 'author',
      }).single;
      expect(imported['enabled'], false);
      expect(imported['author'], 'author');
      expect(
        imported['searchApiConfig']['sourceTemplate'],
        'https://example.com/GV@source/',
      );
    },
  );
}
