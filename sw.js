const CACHE_NAME = 'control-horas-v6';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(['/', '/manifest.json']))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // No cachear API (estado de turnos / totales / GPS)
  if (
    url.pathname.startsWith('/register') ||
    url.pathname.startsWith('/login') ||
    url.pathname.startsWith('/start') ||
    url.pathname.startsWith('/stop') ||
    url.pathname.startsWith('/location') ||
    url.pathname.startsWith('/active') ||
    url.pathname.startsWith('/daily') ||
    url.pathname.startsWith('/weekly') ||
    url.pathname.startsWith('/week-days') ||
    url.pathname.startsWith('/history') ||
    url.pathname.startsWith('/all-users') ||
    url.pathname.startsWith('/login-admin')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Documentos (/, /index.html): network-first para no quedar con HTML viejo
  const isDocumentNav =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html';

  if (isDocumentNav) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then(r => r || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});

// Notificaciones enviadas desde el cliente
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SHOW_NOTIFICATION' && data.title) {
    event.waitUntil(
      self.registration.showNotification(data.title, data.options || {})
    );
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
