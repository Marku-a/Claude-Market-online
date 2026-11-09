// Thin wrapper over the service worker message API. Failures become Errors with a `.code`.
function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return reject(Object.assign(new Error(lastErr.message), { code: 'NETWORK' }));
      resolve(res);
    });
  });
}

function unwrap(res) {
  if (res && res.ok) return res.value;
  throw Object.assign(new Error((res && res.message) || 'error'), { code: (res && res.code) || 'NETWORK' });
}

export async function rpc(chain, method, args) {
  return unwrap(await send({ t: 'call', chain, method, args: args || [] }));
}

export async function openSite(chain, which) {
  unwrap(await send({ t: 'open', chain, which }));
}

export async function closeWorkers() {
  unwrap(await send({ t: 'closeWorkers' }));
}
