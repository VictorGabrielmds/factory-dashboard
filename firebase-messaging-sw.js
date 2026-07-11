// public/firebase-messaging-sw.js

// 1. Importa os scripts do Firebase em segundo plano
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// 2. Configurações reais do seu Firebase (já preenchidas)
const firebaseConfig = {
  apiKey: "AIzaSyCqbJS-VLfwxbJQjxT63kw3PgsGKhGmhrc",
  authDomain: "entregas-781a8.firebaseapp.com",
  projectId: "entregas-781a8",
  storageBucket: "entregas-781a8.firebasestorage.app",
  messagingSenderId: "795582426704",
  appId: "1:795582426704:web:4d4e206be8351ba05d2b55"
};

// 3. Inicializa o Firebase no Service Worker
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// 4. A MÁGICA: Escutar mensagens quando o site está fechado ou em segundo plano
messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.data?.title || "Nova Mensagem";
  const notificationOptions = {
    body: payload.data?.body || "Você tem uma nova mensagem",
    // Logo de verdade em vez do favicon genérico — mesmo ícone do manifest.json.
    icon: '/factory-dashboard/icons/icon.svg',
    badge: '/factory-dashboard/icons/icon.svg',
    vibrate: [200, 100, 200],
    data: { chatId: payload.data?.chatId } // Guardamos o ID do cliente aqui silenciosamente
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});

// 5. O que acontece quando você clica na notificação:
self.addEventListener('notificationclick', (event) => {
  event.notification.close(); // Fecha o cartãozinho
  const chatId = event.notification.data?.chatId;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 1. Tenta encontrar a aba do sistema já aberta e foca nela
      for (const client of clientList) {
        if (client.url.includes('/') && 'focus' in client) {
          client.focus();
          if (chatId) client.postMessage({ type: 'ABRIR_CHAT', chatId });
          return;
        }
      }
      // 2. Se a aba estiver fechada, abre uma nova
      if (clients.openWindow) {
        return clients.openWindow('/factory-dashboard/'); 
      }
    })
  );
});