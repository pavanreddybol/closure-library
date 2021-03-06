/**
 * @license
 * Copyright The Closure Library Authors.
 * SPDX-License-Identifier: Apache-2.0
 */

goog.module('goog.net.WebSocketTest');
goog.setTestOnly();

const EntryPointMonitor = goog.require('goog.debug.EntryPointMonitor');
const ErrorHandler = goog.require('goog.debug.ErrorHandler');
const MockClock = goog.require('goog.testing.MockClock');
const NetWebSocket = goog.require('goog.net.WebSocket');
const PropertyReplacer = goog.require('goog.testing.PropertyReplacer');
const entryPointRegistry = goog.require('goog.debug.entryPointRegistry');
const events = goog.require('goog.events');
const functions = goog.require('goog.functions');
const recordFunction = goog.require('goog.testing.recordFunction');
const testSuite = goog.require('goog.testing.testSuite');

let webSocket;
let mockClock;
let pr;
let testUrl;
let testProtocol;

const originalOnOpen = NetWebSocket.prototype.onOpen_;
const originalOnClose = NetWebSocket.prototype.onClose_;
const originalOnMessage = NetWebSocket.prototype.onMessage_;
const originalOnError = NetWebSocket.prototype.onError_;

/**
 * Simulates the browser firing the open event for the given web socket.
 * @param {MockWebSocket} ws The mock web socket.
 */
function simulateOpenEvent(ws) {
  ws.readyState = NetWebSocket.ReadyState_.OPEN;
  ws.onopen();
}

/**
 * Simulates the browser firing the close event for the given web socket.
 * @param {MockWebSocket} ws The mock web socket.
 */
function simulateCloseEvent(ws) {
  ws.readyState = NetWebSocket.ReadyState_.CLOSED;
  ws.onclose({data: 'mock close event'});
}

/**
 * Strategy for reconnection that backs off linearly with a 1 second offset.
 * @param {number} attempt The number of reconnects since the last connection.
 * @return {number} The amount of time to the next reconnect, in milliseconds.
 */
function linearBackOff(attempt) {
  return (attempt * 1000) + 1000;
}

/**
 * Strategy for reconnection that backs off with the fibonacci pattern.  It is
 * offset by 5 seconds so the first attempt will happen after 5 seconds.
 * @param {number} attempt The number of reconnects since the last connection.
 * @return {number} The amount of time to the next reconnect, in milliseconds.
 */
function fibonacciBackOff(attempt) {
  return (fibonacci(attempt) * 1000) + 5000;
}

/**
 * Computes the desired fibonacci number.
 * @param {number} n The nth desired fibonacci number.
 * @return {number} The nth fibonacci number.
 */
function fibonacci(n) {
  if (n == 0) {
    return 0;
  } else if (n == 1) {
    return 1;
  } else {
    return fibonacci(n - 2) + fibonacci(n - 1);
  }
}

/** Mock WebSocket constructor. */
class MockWebSocket {
  /**
   * @param {string} url The url to the web socket server.
   * @param {string} protocol The protocol to use.
   */
  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = NetWebSocket.ReadyState_.CONNECTING;
  }

  /** Mocks out the close method of the WebSocket. */
  close() {
    this.readyState = NetWebSocket.ReadyState_.CLOSING;
  }

  /** Mocks out the send method of the WebSocket. */
  send() {
    // Nothing to do here.
  }
}

testSuite({
  setUp() {
    pr = new PropertyReplacer();
    pr.set(goog.global, 'WebSocket', MockWebSocket);
    mockClock = new MockClock(true);
    testUrl = 'ws://127.0.0.1:4200';
    testProtocol = 'xmpp';
  },

  tearDown() {
    pr.reset();
    NetWebSocket.prototype.onOpen_ = originalOnOpen;
    NetWebSocket.prototype.onClose_ = originalOnClose;
    NetWebSocket.prototype.onMessage_ = originalOnMessage;
    NetWebSocket.prototype.onError_ = originalOnError;
    goog.dispose(mockClock);
    goog.dispose(webSocket);
  },

  testOpenInUnsupportingBrowserThrowsException() {
    // Null out WebSocket to simulate lack of support.
    if (goog.global.WebSocket) {
      goog.global.WebSocket = null;
    }

    webSocket = new NetWebSocket();
    assertThrows('Open should fail if WebSocket is not defined.', () => {
      webSocket.open(testUrl);
    });
  },

  testOpenTwiceThrowsException() {
    webSocket = new NetWebSocket();
    webSocket.open(testUrl);
    simulateOpenEvent(webSocket.webSocket_);

    assertThrows('Attempting to open a second time should fail.', () => {
      webSocket.open(testUrl);
    });
  },

  testSendWithoutOpeningThrowsException() {
    webSocket = new NetWebSocket();

    assertThrows(
        'Send should fail if the web socket was not first opened.', () => {
          webSocket.send('test message');
        });
  },

  testOpenWithProtocol() {
    webSocket = new NetWebSocket();
    webSocket.open(testUrl, testProtocol);
    const ws = webSocket.webSocket_;
    simulateOpenEvent(ws);
    assertEquals(testUrl, ws.url);
    assertEquals(testProtocol, ws.protocol);
  },

  testOpenAndClose() {
    webSocket = new NetWebSocket();
    assertFalse(webSocket.isOpen());
    webSocket.open(testUrl);
    const ws = webSocket.webSocket_;
    simulateOpenEvent(ws);
    assertTrue(webSocket.isOpen());
    assertEquals(testUrl, ws.url);
    webSocket.close();
    simulateCloseEvent(ws);
    assertFalse(webSocket.isOpen());
  },

  testOpenAndCloseWithOptions() {
    webSocket = new NetWebSocket({
      autoReconnect: true,
      getNextReconnect: linearBackOff,
      binaryType: NetWebSocket.BinaryType.ARRAY_BUFFER,
    });
    assertFalse(webSocket.isOpen());
    webSocket.open(testUrl);
    const ws = webSocket.webSocket_;
    simulateOpenEvent(ws);
    assertTrue(webSocket.isOpen());
    assertEquals(testUrl, ws.url);
    webSocket.close();
    simulateCloseEvent(ws);
    assertFalse(webSocket.isOpen());
  },

  testReconnectionDisabled() {
    // Construct the web socket and disable reconnection.
    webSocket = new NetWebSocket({autoReconnect: false});

    // Record how many times open is called.
    pr.set(webSocket, 'open', recordFunction(webSocket.open));

    // Open the web socket.
    webSocket.open(testUrl);
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());
    assertFalse(webSocket.isOpen());

    // Simulate failure.
    const ws = webSocket.webSocket_;
    simulateCloseEvent(ws);
    assertFalse(webSocket.isOpen());
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());

    // Make sure a reconnection doesn't happen.
    mockClock.tick(100000);
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());
  },

  testReconnectionWithFailureOnFirstOpen() {
    // Construct the web socket with a linear back-off.
    webSocket = new NetWebSocket(
        {autoReconnect: true, getNextReconnext: linearBackOff});

    // Record how many times open is called.
    pr.set(webSocket, 'open', recordFunction(webSocket.open));

    // Open the web socket.
    webSocket.open(testUrl, testProtocol);
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());
    assertFalse(webSocket.isOpen());

    // Simulate failure.
    const ws = webSocket.webSocket_;
    simulateCloseEvent(ws);
    assertFalse(webSocket.isOpen());
    assertEquals(1, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());

    // Make sure the reconnect doesn't happen before it should.
    mockClock.tick(linearBackOff(0) - 1);
    assertEquals(1, webSocket.open.getCallCount());
    mockClock.tick(1);
    assertEquals(2, webSocket.open.getCallCount());

    // Simulate another failure.
    simulateCloseEvent(ws);
    assertFalse(webSocket.isOpen());
    assertEquals(2, webSocket.reconnectAttempt_);
    assertEquals(2, webSocket.open.getCallCount());

    // Make sure the reconnect doesn't happen before it should.
    mockClock.tick(linearBackOff(1) - 1);
    assertEquals(2, webSocket.open.getCallCount());
    mockClock.tick(1);
    assertEquals(3, webSocket.open.getCallCount());

    // Simulate connection success.
    simulateOpenEvent(ws);
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(3, webSocket.open.getCallCount());

    // Make sure the reconnection has the same url and protocol.
    assertEquals(testUrl, ws.url);
    assertEquals(testProtocol, ws.protocol);

    // Ensure no further calls to open are made.
    mockClock.tick(linearBackOff(10));
    assertEquals(3, webSocket.open.getCallCount());
  },

  testReconnectionWithFailureAfterOpen() {
    // Construct the web socket with a linear back-off.
    webSocket = new NetWebSocket(
        {autoReconnect: true, getNextReconnect: fibonacciBackOff});

    // Record how many times open is called.
    pr.set(webSocket, 'open', recordFunction(webSocket.open));

    // Open the web socket.
    webSocket.open(testUrl);
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());
    assertFalse(webSocket.isOpen());

    // Simulate connection success.
    let ws = webSocket.webSocket_;
    simulateOpenEvent(ws);
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());

    // Let some time pass, then fail the connection.
    mockClock.tick(100000);
    simulateCloseEvent(ws);
    assertFalse(webSocket.isOpen());
    assertEquals(1, webSocket.reconnectAttempt_);
    assertEquals(1, webSocket.open.getCallCount());

    // Make sure the reconnect doesn't happen before it should.
    mockClock.tick(fibonacciBackOff(0) - 1);
    assertEquals(1, webSocket.open.getCallCount());
    mockClock.tick(1);
    assertEquals(2, webSocket.open.getCallCount());

    // Simulate connection success.
    ws = webSocket.webSocket_;
    simulateOpenEvent(ws);
    assertEquals(0, webSocket.reconnectAttempt_);
    assertEquals(2, webSocket.open.getCallCount());

    // Ensure no further calls to open are made.
    mockClock.tick(fibonacciBackOff(10));
    assertEquals(2, webSocket.open.getCallCount());
  },

  testExponentialBackOff() {
    assertEquals(1000, NetWebSocket.EXPONENTIAL_BACKOFF_(0));
    assertEquals(2000, NetWebSocket.EXPONENTIAL_BACKOFF_(1));
    assertEquals(4000, NetWebSocket.EXPONENTIAL_BACKOFF_(2));
    assertEquals(60000, NetWebSocket.EXPONENTIAL_BACKOFF_(6));
    assertEquals(60000, NetWebSocket.EXPONENTIAL_BACKOFF_(7));
  },

  testEntryPointRegistry() {
    const monitor = new EntryPointMonitor();
    const replacement = () => {};
    monitor.wrap = recordFunction(functions.constant(replacement));

    entryPointRegistry.monitorAll(monitor);
    assertTrue(monitor.wrap.getCallCount() >= 1);
    assertEquals(replacement, NetWebSocket.prototype.onOpen_);
    assertEquals(replacement, NetWebSocket.prototype.onClose_);
    assertEquals(replacement, NetWebSocket.prototype.onMessage_);
    assertEquals(replacement, NetWebSocket.prototype.onError_);
  },

  testErrorHandlerCalled() {
    let errorHandlerCalled = false;
    const errorHandler = new ErrorHandler(() => {
      errorHandlerCalled = true;
    });
    NetWebSocket.protectEntryPoints(errorHandler);

    webSocket = new NetWebSocket();
    events.listenOnce(webSocket, NetWebSocket.EventType.OPENED, () => {
      throw new Error();
    });

    webSocket.open(testUrl);
    const ws = webSocket.webSocket_;
    assertThrows(() => {
      simulateOpenEvent(ws);
    });

    assertTrue(
        'Error handler callback should be called when registered as ' +
            'protecting the entry points.',
        errorHandlerCalled);
  },
});
