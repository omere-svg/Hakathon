import { capitalize, includesAnyPhrase } from '../util/text';

// Deterministic SAFETY-SIGNAL extraction — not "the brain". We only detect the few
// things the engine must act on reliably regardless of the model: a stated name
// preference, distress, and the kind of request. The LLM does the real understanding
// of content. Tools (grade.ts) judge correctness. These cues shape the situation brief.

export type RequestType = 'answer' | 'hint' | 'explanation' | 'example' | 'runnable' | 'none';

export interface Cues {
  preferredName?: string;
  rejectedName?: string;
  distress: boolean;
  requestType: RequestType;
  isAnswerAttempt: boolean;
}

const DISTRESS = ['about to quit', 'want to quit', 'give up', "can't do this", 'cant do this', 'so frustrated', 'really frustrated', 'stuck for', 'for hours', 'two hours', 'feel behind', 'feel really behind', 'feeling behind', 'overwhelmed', 'not cut out', 'hate this'];
const HINT = ['hint', 'nudge', "i'm stuck", 'im stuck', 'help me', 'a little help', 'point me', 'not sure where'];
const ANSWER = ['just tell me', 'give me the answer', "what's the answer", 'whats the answer', 'tell me the answer', 'answer please', 'just give me the answer'];
const RUNNABLE = ['paste and run', 'paste it', 'one-liner', 'one liner', 'i can paste', 'i can run', 'copy and paste', 'copy paste', 'code i can run', 'runnable', 'ready to run'];
const EXPLANATION = ['what is', 'what are', 'explain', "don't understand", 'dont understand', 'how does', 'how do', "i'm confused", 'im confused', 'confused', 'what does', 'no idea', "don't get", 'dont get'];
const EXAMPLE = ['example', 'show me', 'showed me', 'demonstrate'];

const NAME_PATTERNS: { re: RegExp; pref: number; rej?: number }[] = [
  { re: /call me ([a-zA-Z'’-]{2,20}),?\s*not ([a-zA-Z'’-]{2,20})/i, pref: 1, rej: 2 },
  { re: /not ([a-zA-Z'’-]{2,20}),?\s*call me ([a-zA-Z'’-]{2,20})/i, pref: 2, rej: 1 },
  { re: /(?:please )?call me ([a-zA-Z'’-]{2,20})/i, pref: 1 },
  { re: /i(?:'?d| would)? prefer (?:to be called )?([a-zA-Z'’-]{2,20})/i, pref: 1 },
  { re: /my name(?:'?s| is) ([a-zA-Z'’-]{2,20})/i, pref: 1 },
];

function extractName(msg: string): { preferredName?: string; rejectedName?: string } {
  for (const p of NAME_PATTERNS) {
    const m = msg.match(p.re);
    if (!m) continue;
    const preferredName = capitalize(m[p.pref]);
    const rejectedName = p.rej ? capitalize(m[p.rej]) : undefined;
    if (rejectedName && rejectedName.toLowerCase() === preferredName.toLowerCase()) return { preferredName };
    return { preferredName, rejectedName };
  }
  return {};
}

function classifyRequest(msg: string): RequestType {
  if (includesAnyPhrase(msg, RUNNABLE)) return 'runnable';
  if (includesAnyPhrase(msg, ANSWER)) return 'answer';
  if (includesAnyPhrase(msg, HINT)) return 'hint';
  if (includesAnyPhrase(msg, EXAMPLE)) return 'example';
  if (includesAnyPhrase(msg, EXPLANATION)) return 'explanation';
  return 'none';
}

export function readCues(message: string, hasActiveCheck: boolean): Cues {
  const msg = message.trim();
  const name = extractName(msg);
  const requestType = classifyRequest(msg);
  // An answer attempt = there's an open question and the student isn't asking for
  // help/an explanation, and isn't just stating a preference (e.g. "call me Sam").
  const isAnswerAttempt = hasActiveCheck && msg.length > 0 && requestType === 'none' && !name.preferredName;
  return {
    preferredName: name.preferredName,
    rejectedName: name.rejectedName,
    distress: includesAnyPhrase(msg, DISTRESS),
    requestType,
    isAnswerAttempt,
  };
}
