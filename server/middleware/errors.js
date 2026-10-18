export const apiNotFound = (req, res) => res.status(404).json({ error: 'API 不存在' });

export const handleError = (error, req, res, next) => {
  if (res.destroyed) return;
  if (res.headersSent) return next(error);
  const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
  if (status === 500) console.error('[kazumi-web]', error);
  res.status(status).json({
    ...(error.compatibility ? { code: error.code, compatibility: error.compatibility } : {}),
    error:
      error.type === 'entity.parse.failed'
        ? '请求 JSON 格式无效'
        : status === 500
          ? '服务器处理请求失败'
          : error.message,
  });
};
