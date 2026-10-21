import { sanitizeDiagnosticText } from '../../../shared/diagnostic-text.js';

export function createResolutionLogger({ onDiagnostic, signal } = {}) {
  let count = 0;
  return (scope, message, level = 'info') => {
    if (!onDiagnostic || signal?.aborted || count >= 250) return;
    count++;
    onDiagnostic({
      time: Date.now(),
      phase: 'resolve',
      level,
      scope,
      message: sanitizeDiagnosticText(message),
    });
  };
}
