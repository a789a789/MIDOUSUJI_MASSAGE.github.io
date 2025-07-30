/**
 * Enhanced Service Worker for 御堂筋足體舒壓館
 * Features: Advanced caching, background sync, push notifications, offline support
 */

const CACHE_NAME = 'midosuji-spa-v2024.1';
const STATIC_CACHE_NAME = 'midosuji-static-v1';
const DYNAMIC_CACHE_NAME = 'midosuji-dynamic-v1';
const OFFLINE_PAGE = '/offline.html';

// Resources to cache immediately
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  './images/logo.png',
  './images/hero-main.jpg',
  './images/about-us.jpg',
  './images/gallery-lobby.jpg',
  './images/gallery-massage-room.jpg',
  './images/gallery-foot-bath.jpg',
  './images/gallery-acupressure-room.jpg',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;600;700&display=swap'
];

// Cache strategies
const CACHE_STRATEGIES = {
  CACHE_FIRST: 'cache-first',
  NETWORK_FIRST: 'network-first',
  STALE_WHILE_REVALIDATE: 'stale-while-revalidate',
  NETWORK_ONLY: 'network-only',
  CACHE_ONLY: 'cache-only'
};

// Route configurations
const ROUTE_CONFIG = {
  static: {
    pattern: /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/,
    strategy: CACHE_STRATEGIES.CACHE_FIRST,
    cacheName: STATIC_CACHE_NAME,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    maxEntries: 100
  },
  pages: {
    pattern: /^https?:\/\/[^\/]+\/?$/,
    strategy: CACHE_STRATEGIES.NETWORK_FIRST,
    cacheName: DYNAMIC_CACHE_NAME,
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    maxEntries: 50
  },
  api: {
    pattern: /\/api\//,
    strategy: CACHE_STRATEGIES.NETWORK_FIRST,
    cacheName: 'api-cache',
    maxAge: 5 * 60 * 1000, // 5 minutes
    maxEntries: 100
  }
};

/**
 * Utility Functions
 */
class CacheManager {
  static async openCache(cacheName) {
    return await caches.open(cacheName);
  }

  static async addToCache(cacheName, request, response) {
    const cache = await this.openCache(cacheName);
    await cache.put(request, response.clone());
  }

  static async getFromCache(cacheName, request) {
    const cache = await this.openCache(cacheName);
    return await cache.match(request);
  }

  static async deleteOldCaches(currentCaches) {
    const cacheNames = await caches.keys();
    const deletePromises = cacheNames
      .filter(cacheName => !currentCaches.includes(cacheName))
      .map(cacheName => caches.delete(cacheName));
    
    return Promise.all(deletePromises);
  }

  static async trimCache(cacheName, maxItems) {
    const cache = await this.openCache(cacheName);
    const keys = await cache.keys();
    
    if (keys.length > maxItems) {
      const deletePromises = keys
        .slice(0, keys.length - maxItems)
        .map(key => cache.delete(key));
      
      await Promise.all(deletePromises);
    }
  }

  static async cleanExpiredEntries(cacheName, maxAge) {
    const cache = await this.openCache(cacheName);
    const keys = await cache.keys();
    const now = Date.now();
    
    for (const key of keys) {
      const response = await cache.match(key);
      if (response) {
        const dateHeader = response.headers.get('date');
        const responseTime = dateHeader ? new Date(dateHeader).getTime() : 0;
        
        if (now - responseTime > maxAge) {
          await cache.delete(key);
        }
      }
    }
  }
}

class NetworkManager {
  static async fetchWithTimeout(request, timeout = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(request, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  static async fetchWithRetry(request, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await this.fetchWithTimeout(request);
      } catch (error) {
        lastError = error;
        if (i < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        }
      }
    }
    
    throw lastError;
  }
}

class BackgroundSync {
  static async queueRequest(request, data) {
    const syncStore = await this.openSyncStore();
    const id = Date.now().toString();
    
    await syncStore.put(id, {
      request: {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: data
      },
      timestamp: Date.now()
    });
    
    return id;
  }

  static async openSyncStore() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('sync-store', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('requests')) {
          db.createObjectStore('requests');
        }
      };
    });
  }

  static async processQueue() {
    try {
      const db = await this.openSyncStore();
      const transaction = db.transaction(['requests'], 'readwrite');
      const store = transaction.objectStore('requests');
      const requests = await new Promise((resolve, reject) => {
        const getAllRequest = store.getAll();
        getAllRequest.onsuccess = () => resolve(getAllRequest.result);
        getAllRequest.onerror = () => reject(getAllRequest.error);
      });

      for (const request of requests) {
        try {
          await NetworkManager.fetchWithRetry(new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body
          }));
          
          // Remove successful request from queue
          await new Promise((resolve, reject) => {
            const deleteRequest = store.delete(request.id);
            deleteRequest.onsuccess = () => resolve();
            deleteRequest.onerror = () => reject(deleteRequest.error);
          });
        } catch (error) {
          console.log('Failed to sync request:', error);
        }
      }
    } catch (error) {
      console.log('Background sync failed:', error);
    }
  }
}

/**
 * Cache Strategy Implementations
 */
async function cacheFirst(request, options) {
  const cachedResponse = await CacheManager.getFromCache(options.cacheName, request);
  
  if (cachedResponse) {
    // Update cache in background if stale
    if (options.maxAge) {
      const responseTime = new Date(cachedResponse.headers.get('date')).getTime();
      if (Date.now() - responseTime > options.maxAge) {
        // Don't await - update in background
        NetworkManager.fetchWithRetry(request)
          .then(response => {
            if (response.ok) {
              CacheManager.addToCache(options.cacheName, request, response);
            }
          })
          .catch(error => console.log('Background update failed:', error));
      }
    }
    return cachedResponse;
  }
  
  try {
    const networkResponse = await NetworkManager.fetchWithRetry(request);
    if (networkResponse.ok) {
      await CacheManager.addToCache(options.cacheName, request, networkResponse);
    }
    return networkResponse;
  } catch (error) {
    return new Response('Offline - Content not available', { status: 503 });
  }
}

async function networkFirst(request, options) {
  try {
    const networkResponse = await NetworkManager.fetchWithRetry(request);
    if (networkResponse.ok) {
      await CacheManager.addToCache(options.cacheName, request, networkResponse);
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await CacheManager.getFromCache(options.cacheName, request);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Return offline page for navigation requests
    if (request.destination === 'document') {
      const offlinePage = await CacheManager.getFromCache(CACHE_NAME, '/');
      return offlinePage || new Response('Offline', { status: 503 });
    }
    
    throw error;
  }
}

async function staleWhileRevalidate(request, options) {
  const cachedResponse = await CacheManager.getFromCache(options.cacheName, request);
  
  // Always try to update from network
  const networkPromise = NetworkManager.fetchWithRetry(request)
    .then(response => {
      if (response.ok) {
        CacheManager.addToCache(options.cacheName, request, response);
      }
      return response;
    })
    .catch(error => console.log('Network update failed:', error));
  
  return cachedResponse || await networkPromise;
}

/**
 * Route Matching and Strategy Selection
 */
function getRouteConfig(request) {
  const url = new URL(request.url);
  
  for (const [name, config] of Object.entries(ROUTE_CONFIG)) {
    if (config.pattern.test(url.pathname + url.search)) {
      return { name, ...config };
    }
  }
  
  // Default strategy
  return {
    name: 'default',
    strategy: CACHE_STRATEGIES.NETWORK_FIRST,
    cacheName: DYNAMIC_CACHE_NAME,
    maxAge: 24 * 60 * 60 * 1000,
    maxEntries: 50
  };
}

async function handleRequest(request) {
  const routeConfig = getRouteConfig(request);
  
  switch (routeConfig.strategy) {
    case CACHE_STRATEGIES.CACHE_FIRST:
      return cacheFirst(request, routeConfig);
    case CACHE_STRATEGIES.NETWORK_FIRST:
      return networkFirst(request, routeConfig);
    case CACHE_STRATEGIES.STALE_WHILE_REVALIDATE:
      return staleWhileRevalidate(request, routeConfig);
    case CACHE_STRATEGIES.NETWORK_ONLY:
      return NetworkManager.fetchWithRetry(request);
    case CACHE_STRATEGIES.CACHE_ONLY:
      return CacheManager.getFromCache(routeConfig.cacheName, request);
    default:
      return networkFirst(request, routeConfig);
  }
}

/**
 * Service Worker Event Handlers
 */

// Install Event
self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  
  event.waitUntil(
    (async () => {
      try {
        const cache = await CacheManager.openCache(CACHE_NAME);
        await cache.addAll(STATIC_ASSETS);
        console.log('Static assets cached successfully');
        
        // Skip waiting to activate immediately
        await self.skipWaiting();
      } catch (error) {
        console.error('Cache installation failed:', error);
      }
    })()
  );
});

// Activate Event
self.addEventListener('activate', event => {
  console.log('Service Worker activating...');
  
  event.waitUntil(
    (async () => {
      try {
        // Clean up old caches
        const currentCaches = [CACHE_NAME, STATIC_CACHE_NAME, DYNAMIC_CACHE_NAME];
        await CacheManager.deleteOldCaches(currentCaches);
        
        // Claim all clients
        await self.clients.claim();
        
        console.log('Service Worker activated successfully');
      } catch (error) {
        console.error('Service Worker activation failed:', error);
      }
    })()
  );
});

// Fetch Event
self.addEventListener('fetch', event => {
  // Skip non-GET requests and chrome-extension requests
  if (event.request.method !== 'GET' || 
      event.request.url.startsWith('chrome-extension://')) {
    return;
  }
  
  event.respondWith(handleRequest(event.request));
});

// Background Sync
self.addEventListener('sync', event => {
  console.log('Background sync triggered:', event.tag);
  
  if (event.tag === 'contact-form-sync') {
    event.waitUntil(BackgroundSync.processQueue());
  }
});

// Push Event
self.addEventListener('push', event => {
  console.log('Push notification received');
  
  const options = {
    body: event.data ? event.data.text() : '感謝您選擇御堂筋足體舒壓館！',
    icon: './images/logo.png',
    badge: './images/logo.png',
    image: './images/hero-main.jpg',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '1',
      url: '/'
    },
    actions: [
      {
        action: 'book',
        title: '立即預約',
        icon: './images/logo.png'
      },
      {
        action: 'view',
        title: '查看服務',
        icon: './images/logo.png'
      },
      {
        action: 'close',
        title: '關閉'
      }
    ],
    requireInteraction: true,
    tag: 'midosuji-notification'
  };
  
  event.waitUntil(
    self.registration.showNotification('御堂筋足體舒壓館', options)
  );
});

// Notification Click Event
self.addEventListener('notificationclick', event => {
  console.log('Notification clicked:', event.notification.tag);
  
  event.notification.close();
  
  const action = event.action;
  let url = '/';
  
  switch (action) {
    case 'book':
      url = '/#contact';
      break;
    case 'view':
      url = '/#services';
      break;
    case 'close':
      return;
    default:
      url = event.notification.data?.url || '/';
  }
  
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      // Check if there's already a window/tab open with the target URL
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      
      // If not, open a new window/tab
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// Message Event (for communication with main thread)
self.addEventListener('message', event => {
  console.log('Service Worker received message:', event.data);
  
  if (event.data && event.data.type) {
    switch (event.data.type) {
      case 'SKIP_WAITING':
        self.skipWaiting();
        break;
      case 'CACHE_URLS':
        event.waitUntil(
          (async () => {
            const cache = await CacheManager.openCache(DYNAMIC_CACHE_NAME);
            await cache.addAll(event.data.urls);
          })()
        );
        break;
      case 'CLEAR_CACHE':
        event.waitUntil(
          CacheManager.deleteOldCaches([])
        );
        break;
    }
  }
});

// Periodic Background Sync (for modern browsers)
self.addEventListener('periodicsync', event => {
  console.log('Periodic background sync:', event.tag);
  
  if (event.tag === 'cache-cleanup') {
    event.waitUntil(
      (async () => {
        // Clean expired entries
        for (const [name, config] of Object.entries(ROUTE_CONFIG)) {
          await CacheManager.cleanExpiredEntries(config.cacheName, config.maxAge);
          await CacheManager.trimCache(config.cacheName, config.maxEntries);
        }
      })()
    );
  }
});

// Error Handling
self.addEventListener('error', event => {
  console.error('Service Worker error:', event.error);
});

self.addEventListener('unhandledrejection', event => {
  console.error('Service Worker unhandled rejection:', event.reason);
  event.preventDefault();
});

// Performance monitoring
self.addEventListener('fetch', event => {
  const start = performance.now();
  
  event.respondWith(
    handleRequest(event.request).then(response => {
      const duration = performance.now() - start;
      console.log(`Request to ${event.request.url} took ${duration.toFixed(2)}ms`);
      return response;
    })
  );
});

console.log('Service Worker script loaded successfully');