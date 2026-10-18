import { Script } from 'node:vm';
import { HttpError } from '../../lib/http.js';

const test = new Script("new RegExp(pattern, 'is').test(input)");

export function matchChallengeRegex(raw, pattern) {
  try {
    // Construct the RegExp inside this context so its backtracking is also
    // interrupted by V8's execution deadline. The pattern remains string data.
    return test.runInNewContext({ pattern, input: raw }, { timeout: 50 });
  } catch (error) {
    if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
      throw new HttpError('验证码正则检测超时，请修改规则的正则表达式', 422);
    return false; // Native Kazumi treats malformed detection patterns as no match.
  }
}
