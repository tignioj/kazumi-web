import { HttpError } from '../../lib/http.js';

export function sourceFailure(error) {
  if (error.code === 'VERIFICATION_REQUIRED') return error;
  const code = error.code || error.cause?.code || error.cause?.cause?.code;
  let kind = error.sourceCode;
  if (!kind && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/.test(code || ''))
    kind = 'SOURCE_CERTIFICATE_ERROR';
  if (!kind && /TLS|SSL/.test(code || '')) kind = 'SOURCE_TLS_ERROR';
  if (!kind && /CONNECT_TIMEOUT|ETIMEDOUT/.test(code || '')) kind = 'SOURCE_CONNECT_TIMEOUT';
  if (
    !kind &&
    /ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET/.test(code || '')
  )
    kind = 'SOURCE_CONNECTION_ERROR';
  if (!kind && (/TIMEOUT/.test(code || '') || error.name === 'TimeoutError'))
    kind = 'SOURCE_TIMEOUT';
  if (kind) {
    const messages = {
      SOURCE_CERTIFICATE_ERROR: '来源站点证书校验失败，请检查站点证书或视频代理设置',
      SOURCE_TLS_ERROR: '来源站点 TLS 握手失败，请检查站点或视频代理设置',
      SOURCE_CONNECT_TIMEOUT: '连接来源站点超时，请稍后重试或检查视频代理设置',
      SOURCE_CONNECTION_ERROR: '来源连接中断，请重试或检查视频代理设置',
      SOURCE_TIMEOUT: '来源站点响应超时，请稍后重试或更换片源',
    };
    return Object.assign(new HttpError(messages[kind], 502), { code: kind, cause: error });
  }
  if (error instanceof HttpError) {
    error.code ||= /HTTP \d+/.test(error.message) ? 'SOURCE_HTTP_ERROR' : 'SOURCE_RULE_ERROR';
    return error;
  }
  return Object.assign(new HttpError('来源规则解析失败，请更新规则或更换片源', 502), {
    code: 'SOURCE_RULE_ERROR',
    cause: error,
  });
}
