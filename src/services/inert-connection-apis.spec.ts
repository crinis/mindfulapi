import { installInertConnectionApis } from './inert-connection-apis';

/** The APIs the init script replaces, as page script sees them. */
const NAMES = [
  'SharedWorker',
  'WebSocketStream',
  'WebTransport',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
] as const;

type Scope = Record<string, any>;

/** Next macrotask: every stand-in reports its failure by then. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('installInertConnectionApis', () => {
  const scope = globalThis as Scope;
  /** A native constructor that must never be called. */
  const native = jest.fn();

  beforeEach(() => {
    native.mockClear();
    for (const name of NAMES) {
      scope[name] = function NativeApi() {
        native(name);
      };
    }
    installInertConnectionApis();
  });

  afterEach(() => {
    for (const name of NAMES) delete scope[name];
  });

  it('replaces every API the document has, keeping it a constructor', () => {
    for (const name of NAMES) {
      expect(typeof scope[name]).toBe('function');
      expect(Object.getOwnPropertyDescriptor(scope, name)).toMatchObject({
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    expect(scope.webkitRTCPeerConnection).toBe(scope.RTCPeerConnection);
  });

  it('leaves an API the document does not have missing', () => {
    // WebTransport, for example, exists in secure contexts only.
    delete scope.WebTransport;
    installInertConnectionApis();

    expect('WebTransport' in scope).toBe(false);
  });

  it('never calls the native constructors', () => {
    new scope.SharedWorker('/worker.js');
    new scope.WebSocketStream('wss://example.com/live');
    new scope.WebTransport('https://example.com/wt');
    new scope.RTCPeerConnection({ iceServers: [] });

    expect(native).not.toHaveBeenCalled();
  });

  it('fails a SharedWorker with an error event, like a script that did not load', async () => {
    const worker = new scope.SharedWorker('/worker.js', { name: 'sync' });
    const listener = jest.fn();
    worker.addEventListener('error', listener);
    worker.onerror = jest.fn();

    // The page can still talk to its port without anything listening.
    worker.port.start();
    worker.port.postMessage('hello');
    expect(listener).not.toHaveBeenCalled();
    await nextTask();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(worker.onerror).toHaveBeenCalledTimes(1);
    worker.port.close();
  });

  it('rejects the opened and closed promises of a WebSocketStream', async () => {
    const stream = new scope.WebSocketStream('wss://example.com/live');

    expect(stream.url).toBe('wss://example.com/live');
    await expect(stream.opened).rejects.toMatchObject({
      name: 'NetworkError',
    });
    await expect(stream.closed).rejects.toMatchObject({
      name: 'NetworkError',
    });
    expect(() => stream.close()).not.toThrow();
  });

  it('rejects the ready and closed promises and the streams of a WebTransport', async () => {
    const transport = new scope.WebTransport('https://example.com/wt');

    await expect(transport.ready).rejects.toMatchObject({
      name: 'NetworkError',
    });
    await expect(transport.closed).rejects.toMatchObject({
      name: 'NetworkError',
    });
    await expect(transport.createBidirectionalStream()).rejects.toMatchObject({
      name: 'NetworkError',
    });
    await expect(transport.createUnidirectionalStream()).rejects.toMatchObject({
      name: 'NetworkError',
    });
    await expect(
      transport.datagrams.readable.getReader().read(),
    ).rejects.toMatchObject({ name: 'NetworkError' });
    await expect(
      transport.incomingBidirectionalStreams.getReader().read(),
    ).rejects.toMatchObject({ name: 'NetworkError' });
    expect(() => transport.close()).not.toThrow();
  });

  describe('RTCPeerConnection', () => {
    it('signals without a network and ends ICE gathering without candidates', async () => {
      const peer = new scope.RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.example.com' }],
      });
      const candidates: unknown[] = [];
      peer.onicecandidate = (event: { candidate: unknown }) =>
        candidates.push(event.candidate);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await nextTask();

      expect(offer).toMatchObject({ type: 'offer' });
      expect(peer.localDescription).toMatchObject({ type: 'offer' });
      expect(peer.iceGatheringState).toBe('complete');
      // Only the end-of-candidates marker: no address is ever gathered.
      expect(candidates).toEqual([null]);
      expect(peer.getConfiguration()).toEqual({
        iceServers: [{ urls: 'stun:stun.example.com' }],
      });
    });

    it('fails the connection once both descriptions are set', async () => {
      const peer = new scope.RTCPeerConnection();
      const channel = peer.createDataChannel('chat');
      const states: string[] = [];
      peer.addEventListener('connectionstatechange', () =>
        states.push(peer.connectionState),
      );
      const channelEvents: string[] = [];
      channel.onerror = () => channelEvents.push('error');
      channel.onclose = () => channelEvents.push('close');

      expect(channel.readyState).toBe('connecting');
      expect(() => channel.send('hi')).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
      await peer.setLocalDescription(await peer.createOffer());
      await peer.setRemoteDescription({ type: 'answer', sdp: '' });
      await nextTask();

      expect(states).toEqual(['failed']);
      expect(peer.iceConnectionState).toBe('failed');
      expect(channel.readyState).toBe('closed');
      expect(channelEvents).toEqual(['error', 'close']);
    });

    it('answers the rest of the API without throwing', async () => {
      const peer = new scope.RTCPeerConnection();

      await expect(peer.addIceCandidate({})).resolves.toBeUndefined();
      await expect(peer.getStats()).resolves.toEqual(new Map());
      expect(peer.getSenders()).toEqual([]);
      expect(peer.getReceivers()).toEqual([]);
      expect(peer.getTransceivers()).toEqual([]);
      expect(peer.addTrack({ kind: 'audio' })).toMatchObject({
        track: { kind: 'audio' },
      });
      expect(peer.addTransceiver('video')).toMatchObject({
        direction: 'inactive',
      });
      peer.restartIce();
      peer.close();
      expect(peer.connectionState).toBe('closed');
      expect(peer.signalingState).toBe('closed');
    });
  });
});
