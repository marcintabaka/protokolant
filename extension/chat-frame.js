/*
 * Skrypt w ramce czatu Google Chat osadzonej w Meet (chat.google.com, world MAIN).
 *
 * Nowy czat w Meet to ramka Google Chat, więc wiadomości nie przechodzą przez
 * stronę Meet. Przechwytujemy własne wysłane wiadomości (żądanie create_topic,
 * tekst w body[1]) i przekazujemy je do content scriptu Meet
 * przez postMessage. Na prośbę content scriptu wysyłamy powiadomienie o transkrypcji
 * (opcja użytkownika, domyślnie wyłączona). W trybie debug odsyłamy zrzut DOM ramki i listę
 * ostatnich żądań sieciowych, żeby ustalić, jak przychodzą cudze wiadomości.
 */
(() => {
  'use strict';
  if (window.top === window || window.__protokolantChat) return;
  const MEET = 'https://meet.google.com';
  const anc = location.ancestorOrigins;
  if (!anc || !anc.length || anc[anc.length - 1] !== MEET) return;
  window.__protokolantChat = true;

  const TAG = '[Protokolant/chat]';
  const post = (data) => {
    try {
      window.top.postMessage({ source: 'protokolant-chat', ...data }, MEET);
    } catch (e) {
      console.warn(TAG, e);
    }
  };

  const requests = [];
  function note(method, url) {
    requests.push(`${new Date().toISOString().slice(11, 19)} ${method} ${String(url).slice(0, 200)}`);
    if (requests.length > 300) requests.shift();
  }

  function isCreateTopic(url) {
    try {
      return new URL(url, location.origin).pathname.endsWith('/api/create_topic');
    } catch (e) {
      return false;
    }
  }

  function textFromBody(body) {
    if (typeof body !== 'string') return null;
    try {
      const t = JSON.parse(body);
      if (Array.isArray(t) && typeof t[1] === 'string' && t[1].trim()) return t[1];
    } catch (e) {
      /* inny format */
    }
    return null;
  }

  let onSent = null; // oczekiwanie na potwierdzenie wysłania powiadomienia

  function sent(text) {
    console.log(TAG, 'wysłano wiadomość na czacie');
    post({ type: 'own-message', text });
    if (onSent) onSent(text);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    note((init && init.method) || 'GET', url);
    const p = nativeFetch.apply(this, arguments);
    if (isCreateTopic(url)) {
      const text = textFromBody(init && init.body);
      if (text) p.then((r) => r.ok && sent(text)).catch(() => {});
    }
    return p;
  };

  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mtUrl = String(url);
    note(method, url);
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (isCreateTopic(this.__mtUrl || '')) {
      const text = textFromBody(body);
      if (text) {
        this.addEventListener('readystatechange', () => {
          if (this.readyState === 4 && this.status >= 200 && this.status < 300) sent(text);
        });
      }
    }
    return xSend.apply(this, arguments);
  };

  function cleanHtml() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, link, svg, iframe, video, audio, canvas').forEach((n) => n.remove());
    clone.querySelectorAll('img').forEach((n) => n.setAttribute('src', '(removed)'));
    const html = clone.outerHTML;
    return html.length > 800000 ? html.slice(0, 800000) + '\n<!-- (ucięte) -->' : html;
  }

  // ---- wysłanie powiadomienia o transkrypcji (opcja użytkownika) ----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  function waitSent(text, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        onSent = null;
        resolve(false);
      }, ms);
      onSent = (s) => {
        if (s.trim() !== text.trim()) return;
        clearTimeout(t);
        onSent = null;
        resolve(true);
      };
    });
  }

  async function sendMessage(text) {
    const box = await waitFor(() => document.querySelector('div[role="textbox"], textarea'), 8000);
    if (!box) return { ok: false, error: 'nie znaleziono pola wiadomości' };
    const current = box instanceof HTMLTextAreaElement ? box.value : box.textContent;
    if (current && current.trim()) return { ok: false, error: 'pole wiadomości nie jest puste – nie nadpisuję' };
    box.focus();
    if (box instanceof HTMLTextAreaElement) {
      box.value = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, text);
      if (!box.textContent.trim()) {
        box.textContent = text;
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }
    await sleep(200);
    let wait = waitSent(text, 4000);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    if (await wait) return { ok: true };
    const btn = document.querySelector('button[aria-label*="Wyślij" i], button[aria-label*="Send" i]');
    if (btn && !btn.disabled) {
      wait = waitSent(text, 4000);
      btn.click();
      if (await wait) return { ok: true };
    }
    return { ok: false, error: 'wiadomość nie została wysłana' };
  }

  window.addEventListener('message', async (e) => {
    if (e.origin !== MEET || !e.data || e.data.source !== 'protokolant') return;
    if (e.data.type === 'dump-chat') {
      post({ type: 'dump', url: location.href, html: cleanHtml(), requests: requests.slice() });
    } else if (e.data.type === 'send-notice') {
      let r;
      try {
        r = await sendMessage(e.data.text);
      } catch (err) {
        r = { ok: false, error: String(err) };
      }
      console.log(TAG, 'powiadomienie o transkrypcji:', r);
      post({ type: 'notice-result', ...r });
    }
  });

  console.log(TAG, 'załadowany w ramce czatu Meet');
})();
