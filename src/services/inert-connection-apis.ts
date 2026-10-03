/**
 * Replaces the page APIs whose connections Playwright neither routes nor
 * reports — `SharedWorker`, `WebSocketStream`, `WebTransport` and the WebRTC
 * peer connection (`RTCPeerConnection`, `webkitRTCPeerConnection`) — with
 * inert stand-ins, so a scanned page cannot use them to reach hosts the target
 * policy blocks.
 *
 * The stand-ins never open a connection. They exist and construct like the
 * real ones, so page script that uses them without feature detection keeps
 * running (deleting them made such script throw before it rendered), and
 * they fail later, the way a connection the network refused does:
 *
 * - `SharedWorker` fires `error`, as when its script cannot be loaded; its
 *   `port` is a real, unconnected `MessagePort`.
 * - `WebSocketStream` rejects `opened` and `closed`.
 * - `WebTransport` rejects `ready`, `closed` and new streams, and its
 *   incoming streams and datagrams are errored.
 * - `RTCPeerConnection` signals without a network (offers and answers with
 *   an empty SDP), ends ICE gathering without a candidate, and fails the
 *   connection (`connectionState` `failed`, data channels `error` and
 *   `close`) once both descriptions are set.
 *
 * An API the document does not have (e.g. `WebTransport` outside a secure
 * context) stays missing.
 *
 * Runs in every document as a Playwright init script, which serializes the
 * function's source: it must stay self-contained (no imports and no
 * variables from outside the function).
 */
export function installInertConnectionApis(): void {
  const scope = globalThis as unknown as Record<string, unknown>;

  /** Runs a callback after the current task, like a network callback. */
  const later = (callback: () => void): void => {
    setTimeout(callback, 0);
  };
  /** Dispatches an event and then calls the matching `on<type>` handler. */
  const fire = (target: EventTarget, event: Event): void => {
    target.dispatchEvent(event);
    const handler = (target as unknown as Record<string, unknown>)[
      `on${event.type}`
    ];
    if (typeof handler === 'function') handler.call(target, event);
  };
  const refusal = (api: string): DOMException =>
    new DOMException(
      `${api}: the connection was refused (not available in the accessibility scanner)`,
      'NetworkError',
    );
  /** A rejected promise that does not count as unhandled while unused. */
  const rejected = (error: DOMException): Promise<never> => {
    const promise = Promise.reject(error);
    promise.catch(() => undefined);
    return promise;
  };
  const erroredReadable = (error: DOMException): ReadableStream =>
    new ReadableStream({ start: (controller) => controller.error(error) });
  const erroredWritable = (error: DOMException): WritableStream =>
    new WritableStream({ start: (controller) => controller.error(error) });
  const replace = (name: string, stub: unknown): void => {
    if (!(name in scope)) return;
    Object.defineProperty(scope, name, {
      value: stub,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  class SharedWorker extends EventTarget {
    readonly port = new MessageChannel().port1;
    onerror: ((event: Event) => unknown) | null = null;

    constructor(_scriptURL: string | URL, _options?: unknown) {
      super();
      later(() => fire(this, new Event('error')));
    }
  }

  class WebSocketStream {
    readonly url: string;
    readonly opened: Promise<never>;
    readonly closed: Promise<never>;

    constructor(url: string | URL, _options?: unknown) {
      this.url = String(url);
      const error = refusal('WebSocketStream');
      this.opened = rejected(error);
      this.closed = rejected(error);
    }

    close(_closeInfo?: unknown): void {}
  }

  class WebTransport {
    readonly ready: Promise<never>;
    readonly closed: Promise<never>;
    readonly draining: Promise<never>;
    readonly datagrams: Record<string, unknown>;
    readonly incomingBidirectionalStreams: ReadableStream;
    readonly incomingUnidirectionalStreams: ReadableStream;
    readonly reliability = 'pending';
    readonly congestionControl = 'default';

    constructor(_url: string | URL, _options?: unknown) {
      const error = refusal('WebTransport');
      this.ready = rejected(error);
      this.closed = rejected(error);
      this.draining = rejected(error);
      this.datagrams = {
        readable: erroredReadable(error),
        writable: erroredWritable(error),
        maxDatagramSize: 0,
        incomingMaxAge: null,
        outgoingMaxAge: null,
        incomingHighWaterMark: 0,
        outgoingHighWaterMark: 0,
      };
      this.incomingBidirectionalStreams = erroredReadable(error);
      this.incomingUnidirectionalStreams = erroredReadable(error);
    }

    createBidirectionalStream(): Promise<never> {
      return Promise.reject(refusal('WebTransport'));
    }

    createUnidirectionalStream(): Promise<never> {
      return Promise.reject(refusal('WebTransport'));
    }

    getStats(): Promise<never> {
      return Promise.reject(refusal('WebTransport'));
    }

    close(_closeInfo?: unknown): void {}
  }

  class RTCDataChannel extends EventTarget {
    readonly label: string;
    readonly ordered: boolean;
    readonly protocol: string;
    readonly negotiated: boolean;
    readonly id: number | null;
    readonly maxPacketLifeTime: number | null;
    readonly maxRetransmits: number | null;
    readyState: 'connecting' | 'closing' | 'closed' = 'connecting';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType = 'arraybuffer';
    onopen: ((event: Event) => unknown) | null = null;
    onmessage: ((event: Event) => unknown) | null = null;
    onbufferedamountlow: ((event: Event) => unknown) | null = null;
    onerror: ((event: Event) => unknown) | null = null;
    onclosing: ((event: Event) => unknown) | null = null;
    onclose: ((event: Event) => unknown) | null = null;

    constructor(label: string, init: Record<string, unknown> = {}) {
      super();
      this.label = String(label);
      this.ordered = init.ordered !== false;
      this.protocol = typeof init.protocol === 'string' ? init.protocol : '';
      this.negotiated = init.negotiated === true;
      this.id = typeof init.id === 'number' ? init.id : null;
      this.maxPacketLifeTime =
        typeof init.maxPacketLifeTime === 'number'
          ? init.maxPacketLifeTime
          : null;
      this.maxRetransmits =
        typeof init.maxRetransmits === 'number' ? init.maxRetransmits : null;
    }

    send(_data: unknown): void {
      throw new DOMException(
        "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
        'InvalidStateError',
      );
    }

    close(): void {
      this.end(false);
    }

    /** Closes the channel; `failed` reports an error first. */
    end(failed: boolean): void {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      later(() => {
        if (failed) fire(this, new Event('error'));
        fire(this, new Event('close'));
      });
    }
  }

  type Description = { type: string; sdp: string };

  class RTCPeerConnection extends EventTarget {
    localDescription: Description | null = null;
    remoteDescription: Description | null = null;
    signalingState = 'stable';
    iceGatheringState = 'new';
    iceConnectionState = 'new';
    connectionState = 'new';
    readonly canTrickleIceCandidates: boolean | null = null;
    readonly sctp = null;
    onicecandidate: ((event: Event) => unknown) | null = null;
    onicecandidateerror: ((event: Event) => unknown) | null = null;
    onicegatheringstatechange: ((event: Event) => unknown) | null = null;
    oniceconnectionstatechange: ((event: Event) => unknown) | null = null;
    onconnectionstatechange: ((event: Event) => unknown) | null = null;
    onsignalingstatechange: ((event: Event) => unknown) | null = null;
    onnegotiationneeded: ((event: Event) => unknown) | null = null;
    ontrack: ((event: Event) => unknown) | null = null;
    ondatachannel: ((event: Event) => unknown) | null = null;
    private configuration: unknown;
    private readonly channels: RTCDataChannel[] = [];

    constructor(configuration?: unknown) {
      super();
      this.configuration = configuration ?? {};
    }

    static generateCertificate(): Promise<never> {
      return Promise.reject(refusal('RTCPeerConnection'));
    }

    createOffer(): Promise<Description> {
      return Promise.resolve({ type: 'offer', sdp: '' });
    }

    createAnswer(): Promise<Description> {
      return Promise.resolve({ type: 'answer', sdp: '' });
    }

    setLocalDescription(description?: Description): Promise<void> {
      this.localDescription = description ?? { type: 'offer', sdp: '' };
      if (this.iceGatheringState === 'new') {
        later(() => {
          if (this.connectionState === 'closed') return;
          this.iceGatheringState = 'complete';
          fire(this, new Event('icegatheringstatechange'));
          // The end-of-candidates marker, and no candidate before it.
          fire(
            this,
            Object.assign(new Event('icecandidate'), { candidate: null }),
          );
        });
      }
      this.failOnceConnecting();
      return Promise.resolve();
    }

    setRemoteDescription(description: Description): Promise<void> {
      this.remoteDescription = description;
      this.failOnceConnecting();
      return Promise.resolve();
    }

    addIceCandidate(_candidate?: unknown): Promise<void> {
      return Promise.resolve();
    }

    createDataChannel(label: string, init?: Record<string, unknown>) {
      const channel = new RTCDataChannel(label, init);
      if (
        this.connectionState === 'failed' ||
        this.connectionState === 'closed'
      ) {
        channel.end(this.connectionState === 'failed');
      } else {
        this.channels.push(channel);
      }
      return channel;
    }

    addTrack(track: unknown) {
      return this.sender(track);
    }

    removeTrack(_sender: unknown): void {}

    addTransceiver(trackOrKind: unknown) {
      return {
        mid: null,
        direction: 'inactive',
        currentDirection: null,
        sender: this.sender(
          typeof trackOrKind === 'string' ? null : trackOrKind,
        ),
        receiver: {
          track: null,
          getStats: () => Promise.resolve(new Map()),
        },
        setCodecPreferences: () => undefined,
        stop: () => undefined,
      };
    }

    getSenders(): unknown[] {
      return [];
    }

    getReceivers(): unknown[] {
      return [];
    }

    getTransceivers(): unknown[] {
      return [];
    }

    getStats(): Promise<Map<string, unknown>> {
      return Promise.resolve(new Map<string, unknown>());
    }

    getConfiguration(): unknown {
      return this.configuration;
    }

    setConfiguration(configuration: unknown): void {
      this.configuration = configuration;
    }

    restartIce(): void {}

    close(): void {
      this.signalingState = 'closed';
      this.iceConnectionState = 'closed';
      this.connectionState = 'closed';
      for (const channel of this.channels.splice(0)) channel.end(false);
    }

    private sender(track: unknown) {
      return {
        track,
        dtmf: null,
        transport: null,
        getParameters: () => ({}),
        setParameters: () => Promise.resolve(),
        replaceTrack: () => Promise.resolve(),
        getStats: () => Promise.resolve(new Map()),
      };
    }

    /** Fails the connection once both descriptions are set, like failed ICE. */
    private failOnceConnecting(): void {
      if (!this.localDescription || !this.remoteDescription) return;
      later(() => {
        if (this.connectionState !== 'new') return;
        this.iceConnectionState = 'failed';
        this.connectionState = 'failed';
        fire(this, new Event('iceconnectionstatechange'));
        fire(this, new Event('connectionstatechange'));
        for (const channel of this.channels.splice(0)) channel.end(true);
      });
    }
  }

  replace('SharedWorker', SharedWorker);
  replace('WebSocketStream', WebSocketStream);
  replace('WebTransport', WebTransport);
  replace('RTCPeerConnection', RTCPeerConnection);
  replace('webkitRTCPeerConnection', RTCPeerConnection);
}
