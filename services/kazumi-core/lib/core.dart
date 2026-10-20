import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:kazumi/plugins/plugins.dart';
import 'package:kazumi/plugins/api_rule_config.dart';
import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/services/plugin/api_rule_strategy.dart';
import 'package:kazumi/services/plugin/plugin_cookie_manager.dart';
import 'package:kazumi/services/plugin/plugin_import_parser.dart';
import 'package:kazumi/services/plugin/rule_engine.dart';
import 'package:kazumi/services/plugin/rule_engine_models.dart';
import 'package:kazumi/services/plugin/xpath_rule_strategy.dart';
import 'package:kazumi/services/video_source/video_source_format.dart';
import 'package:kazumi/services/video_source/video_source_resolver_pool.dart';
import 'package:kazumi/webview/captcha/captcha_webview_controller.dart';

const upstreamRevision = '025dcb5c2f62db881382c72f191d08b49a9feb41';

/// This service translates HTTP messages, never rule or website semantics.
/// Every rule, template, selector and sniffing implementation belongs to Kazumi.
class KazumiCore {
  KazumiCore({
    RuleEngine? engine,
    CaptchaWebviewController Function()? captchaFactory,
  }) : engine = engine ?? RuleEngine(),
       captchaFactory =
           captchaFactory ?? CaptchaWebviewControllerFactory.getController {
    resolvers.resize(2);
  }

  final RuleEngine engine;
  final CaptchaWebviewController Function() captchaFactory;
  final resolvers = VideoSourceResolverPool();
  final requests = <String, CancelToken>{};
  final captchas = <String, _Captcha>{};
  Future<void> _captchaQueue = Future<void>.value();
  int _nextCaptcha = 0;

  RuleExecutionConfig config(Plugin p) => RuleExecutionConfig(
    pluginName: p.name,
    baseUrl: p.baseUrl,
    usePost: p.usePost,
    searchMode: p.searchMode,
    chapterMode: p.chapterMode,
    searchUrl: p.searchURL,
    searchList: p.searchList,
    searchName: p.searchName,
    searchResult: p.searchResult,
    chapterRoads: p.chapterRoads,
    chapterResult: p.chapterResult,
    searchApiConfig: p.searchApiConfig,
    chapterApiConfig: p.chapterApiConfig,
    antiCrawlerConfig: p.antiCrawlerConfig,
  );

  Plugin plugin(Map<String, dynamic> body) {
    final p = Plugin.fromJson(Map<String, dynamic>.from(body['rule'] as Map));
    // Upstream cookies are keyed by plugin name. Give each browser its own jar.
    p.name = '${p.name}:${body['owner'] ?? 'download'}';
    if (p.requiresNewerClient) throw const FormatException('规则要求更新版本的 Kazumi');
    return p;
  }

  List<Map<String, dynamic>> importRules(dynamic content) {
    final parsed = PluginImportParser.parse(
      content is String ? content : jsonEncode(content),
    );
    if (parsed.failures.isNotEmpty) {
      throw FormatException(parsed.failures.join('；'));
    }
    if (parsed.plugins.isEmpty || parsed.plugins.length > 500) {
      throw const FormatException('一次导入 1 至 500 条规则');
    }
    // enabled and author belong to the Web library, not the execution core.
    final originals = <String, Map>{};
    dynamic decoded = content;
    if (content is String) {
      try {
        decoded = jsonDecode(content);
      } on FormatException {
        decoded = null;
      }
    }
    for (final item in decoded is List ? decoded : [decoded]) {
      if (item is Map && item['name'] is String) {
        originals[(item['name'] as String).toLowerCase()] = item;
      }
    }
    return parsed.plugins.map((p) {
      if (p.requiresNewerClient) {
        throw const FormatException('规则要求更新版本的 Kazumi');
      }
      const strategy = ApiRuleStrategy();
      if (p.searchMode == RuleMode.api) {
        strategy.validateSearchConfig(p.searchApiConfig);
      }
      if (p.chapterMode == RuleMode.api) {
        strategy.validateChapterConfig(p.chapterApiConfig);
      }
      final original = originals[p.name.toLowerCase()];
      return {
        ...p.toJson(),
        'enabled': original?['enabled'] != false,
        if (original?['author'] is String) 'author': original!['author'],
      };
    }).toList();
  }

  Future<Map<String, dynamic>> execute(
    String path,
    Map<String, dynamic> body,
  ) async {
    if (path == '/health') {
      return {
        'status': 'ok',
        'upstream': upstreamRevision,
        'apiLevel': ApiEndpoints.apiLevel,
      };
    }
    if (path == '/validate') return {'rules': importRules(body['content'])};
    if (path == '/cancel') {
      requests[body['requestId']]?.cancel('HTTP client cancelled');
      resolvers.cancel(body['requestId'] as String);
      return {'ok': true};
    }
    if (path.startsWith('/captcha/')) return _captchaRequest(path, body);
    final p = plugin(body);
    final id = body['requestId'] as String;
    final token = CancelToken();
    requests[id] = token;
    try {
      if (path == '/search') {
        final result = await engine.search(
          config(p),
          body['keyword'] as String,
          cancelToken: token,
        );
        return {
          'items': result.response.data
              .map(
                (e) => {
                  'name': e.name,
                  'url': p.searchMode == RuleMode.xpath
                      ? p.buildFullUrl(e.src)
                      : e.src,
                },
              )
              .toList(),
        };
      }
      if (path == '/chapters') {
        final result = await engine.queryChapters(
          config(p),
          body['url'] as String,
          cancelToken: token,
        );
        return {
          'roads': result.roads
              .map(
                (r) => {
                  'name': r.name,
                  'episodes': List.generate(
                    r.data.length,
                    (i) => {'name': r.identifier[i], 'url': r.data[i]},
                  ),
                },
              )
              .toList(),
        };
      }
      if (path == '/resolve') {
        final lease = await _acquireResolver(id, token);
        try {
          final source = await lease.resolve(
            p.buildFullUrl(body['url'] as String),
            useLegacyParser: p.useLegacyParser,
            timeout: const Duration(seconds: 30),
          );
          final cookies = await PluginCookieManager.instance.loadForRequest(
            p.name,
            Uri.parse(source.url),
          );
          return {
            'url': source.url,
            'type':
                source.format == VideoSourceFormat.hls ||
                    Uri.parse(source.url).path.toLowerCase().endsWith('.m3u8')
                ? 'hls'
                : 'video',
            'headers': {
              ...p.buildHttpHeaders(),
              if (PluginCookieManager.instance.userAgentFor(p.name)
                  case final String ua)
                'user-agent': ua,
            },
            'cookies': cookies
                .map(
                  (c) => {
                    'name': c.name,
                    'value': c.value,
                    'domain': (c.domain?.isEmpty ?? true)
                        ? Uri.parse(source.url).host
                        : c.domain,
                    'path': (c.path?.isEmpty ?? true) ? '/' : c.path,
                    'secure': c.secure,
                    'expires': c.expires == null
                        ? -1
                        : c.expires!.millisecondsSinceEpoch / 1000,
                  },
                )
                .toList(),
          };
        } finally {
          resolvers.release(lease);
        }
      }
      throw const FormatException('Unknown operation');
    } finally {
      requests.remove(id);
    }
  }

  Future<VideoSourceResolverLease> _acquireResolver(
    String id,
    CancelToken token,
  ) async {
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    while (true) {
      if (token.isCancelled) {
        throw token.cancelError!;
      }
      final lease = resolvers.tryAcquire(id);
      if (lease != null) return lease;
      if (DateTime.now().isAfter(deadline)) {
        throw const HttpException('解析服务繁忙，请稍后重试');
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
  }

  Future<Map<String, dynamic>> _captchaRequest(
    String path,
    Map<String, dynamic> body,
  ) async {
    if (path == '/captcha/start') {
      if (captchas.length >= 16) throw const HttpException('验证服务繁忙');
      final p = plugin(body);
      final prepared = const XPathRuleStrategy().prepareSearchRequest(
        config(p),
        body['keyword'] as String,
      );
      final pageUrl = prepared.method == 'POST'
          ? Uri.parse(prepared.url)
                .replace(
                  queryParameters: Map<String, String>.from(
                    prepared.body as Map,
                  ),
                )
                .toString()
          : prepared.url;
      final id = '${DateTime.now().microsecondsSinceEpoch}-${++_nextCaptcha}';
      final c = _Captcha(p, captchaFactory());
      captchas[id] = c;
      c.expiry = Timer(const Duration(minutes: 5), () {
        captchas.remove(id);
        c.dispose();
      });
      c.subscriptions.add(
        c.controller.onCaptchaImageFound.listen((image) {
          c.image = image;
        }),
      );
      c.subscriptions.add(
        c.controller.onCaptchaDisappeared.listen((_) {
          c.complete();
        }),
      );
      // Some platform WebViews use a process-global message channel.
      final previous = _captchaQueue;
      final released = Completer<void>();
      _captchaQueue = previous.then((_) => released.future);
      c.release = () {
        if (!released.isCompleted) released.complete();
      };
      unawaited(() async {
        await previous;
        if (c.disposed) return;
        try {
          await c.controller.init();
          final url = pageUrl;
          c.url = url;
          final a = p.antiCrawlerConfig;
          switch (a.captchaType) {
            case 2:
              await c.controller.loadPageForButtonClick(url, a.captchaButton);
              break;
            case 3:
              await c.controller.loadPageForCustomScript(url, a.captchaScript);
              break;
            default:
              await c.controller.loadPage(
                url,
                a.captchaImage,
                inputXpath: a.captchaInput,
              );
          }
        } catch (e) {
          c.error = e.toString();
          c.release?.call();
        }
      }());
      return {'id': id, 'url': pageUrl};
    }
    final c = captchas[body['id']];
    if (c == null) throw const FormatException('验证会话不存在或已过期');
    if (path == '/captcha/cancel') {
      captchas.remove(body['id']);
      c.dispose();
      return {'ok': true};
    }
    if (path == '/captcha/action') {
      final action = body['action'] as Map;
      if (action['type'] == 'answer') {
        final text = action['text'];
        if (text is! String || text.isEmpty || text.length > 64) {
          throw const FormatException('验证码无效');
        }
        final a = c.plugin.antiCrawlerConfig;
        await c.controller.submitCaptchaInteract(
          text,
          a.captchaInput,
          a.captchaButton,
        );
      } else if (action['type'] == 'refresh') {
        c.image = '';
        c.controller.captchaWasFound = false;
        final a = c.plugin.antiCrawlerConfig;
        await c.controller.loadPage(
          c.url,
          a.captchaImage,
          inputXpath: a.captchaInput,
        );
      } else if (action['type'] != 'continue') {
        throw const FormatException('原版验证接口支持输入验证码和继续操作');
      }
    }
    if (c.done && !c.saved) {
      final cookies = await c.controller.getCookieString(c.url);
      final ua = await c.controller.getUserAgent();
      await PluginCookieManager.instance.saveFromWebView(
        c.plugin.name,
        c.url,
        cookies,
        userAgent: ua,
      );
      c.saved = true;
    }
    return {
      'status': c.error != null
          ? 'failed'
          : c.saved
          ? 'completed'
          : 'waiting',
      if (c.error != null) 'error': c.error,
      'mode': 'image',
      'image': c.image,
      'width': 320,
      'height': 120,
    };
  }

  Future<void> close() async {
    for (final token in requests.values) {
      token.cancel();
    }
    for (final c in captchas.values) {
      c.dispose();
    }
    await resolvers.dispose();
  }
}

class _Captcha {
  _Captcha(this.plugin, this.controller);
  final Plugin plugin;
  final CaptchaWebviewController controller;
  final subscriptions = <StreamSubscription>[];
  Timer? expiry;
  void Function()? release;
  String url = '', image = '';
  String? error;
  bool done = false, saved = false, disposed = false;
  void complete() {
    done = true;
  }

  void dispose() {
    if (disposed) return;
    disposed = true;
    expiry?.cancel();
    for (final s in subscriptions) {
      unawaited(s.cancel());
    }
    controller.dispose();
    release?.call();
  }
}
