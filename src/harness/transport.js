// OpenAI への薄いHTTP層。テストではここを差し替える(依存注入)
const BASE = 'https://api.openai.com/v1';

async function post(path, body, apiKey, { stream = false } = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(stream ? { ...body, stream: true } : body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error(`OpenAI ${path} ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return stream ? res : res.json();
}

// SSE を1イベントずつ流す。data: 行だけ見て、それ以外(event:/コメント/空行)は捨てる
async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // 壊れた1イベントで会話全体を落とさない
      }
    }
  }
}

export const openaiTransport = {
  responses: (body) => post('responses', body, process.env.OPENAI_API_KEY),
  moderations: (body) => post('moderations', body, process.env.OPENAI_API_KEY),

  // ストリーム版。text の delta を onDelta へ流しつつ、最後に非ストリームと同じ形の
  // response オブジェクト(id / output / usage を含む)を返す。
  // 呼び出し側はこれ以降を今までどおり扱えばよい。
  async stream(body, onDelta) {
    const res = await post('responses', body, process.env.OPENAI_API_KEY, { stream: true });
    let final = null;
    for await (const ev of sse(res)) {
      if (ev.type === 'response.output_text.delta' && ev.delta) {
        onDelta?.(ev.delta);
      } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
        final = ev.response;
      } else if (ev.type === 'response.failed') {
        const e = new Error(`OpenAI stream failed: ${ev.response?.error?.message ?? 'unknown'}`);
        e.status = 500;
        throw e;
      } else if (ev.type === 'error') {
        const e = new Error(`OpenAI stream error: ${ev.message ?? ev.error?.message ?? 'unknown'}`);
        // プロンプト段階のブロックは非ストリームと同じ扱いにしたいので status を持たせる
        e.status = ev.status ?? ev.error?.status ?? 500;
        throw e;
      }
    }
    if (!final) throw new Error('OpenAI stream: response.completed が来なかった');
    return final;
  },
};
