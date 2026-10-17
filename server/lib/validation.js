import { HttpError } from './http.js';

export function inputText(value, label, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new HttpError(`${label}不能为空且不能超过 ${maximum} 个字符`);
  return value.trim();
}

export function pageNumber(value) {
  const page = Number(value ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 1000)
    throw new HttpError('页码必须为 1 至 1000');
  return page;
}
