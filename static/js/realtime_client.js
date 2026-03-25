// Shared Socket.IO client configuration for master/player.
// Exposes a small global helper (no bundler required).

(function () {
  function createDndSocket(extraOptions) {
    const baseOptions = {
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      // Allow fallback for unreliable networks.
      transports: ['websocket', 'polling'],
    };

    return io(Object.assign(baseOptions, extraOptions || {}));
  }

  window.createDndSocket = createDndSocket;
})();

