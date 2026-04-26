// api/index.js
import ReconnectingWebSocket from 'reconnecting-websocket';

// Resolution order:
//   1. VITE_WS_URL env var at build time (e.g. ws://my-pi:8080/ws)
//   2. Same-origin /ws — works when the pod binary serves the embedded UI
//      and the WebSocket from the same :8080 listener (production layout).
//   3. Fallback to ws://rpi.local:8080/ws to preserve the historical default.
function resolveWsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  if (typeof window !== 'undefined' && window.location && window.location.host) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://rpi.local:8080/ws';
}

var socket = new ReconnectingWebSocket(resolveWsUrl());

let connect = cb => {
  console.log("Attempting Connection...");

  socket.onopen = () => {
    console.log("Successfully Connected");
  };

  socket.onmessage = msg => {
    cb(JSON.parse(msg.data));
  };

  socket.onclose = event => {
    console.log("Socket Closed Connection: ", event);
  };

  socket.onerror = error => {
    console.log("Socket Error: ", error);
  };
};

let sendMsg = msg => {
  console.log("sending msg: ", msg);
  socket.send(JSON.stringify(msg));
};

export { connect, sendMsg };
