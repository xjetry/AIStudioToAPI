(() => {
  if (window.self === window.top) {
    const params = new URLSearchParams(window.location.search);
    if (params.has('__auto_close')) {
      window.close();
    }
    // Do not run the shim in the main window, only in iframes.
    return;
  }

  window.API_KEY = 'GEMINI_API_KEY';
  window.GEMINI_API_KEY = 'GEMINI_API_KEY';
  window.process = window.process || {};
  window.process.env = window.process.env || {};
  window.process.env.API_KEY = window.API_KEY;
  window.process.env.GEMINI_API_KEY = window.GEMINI_API_KEY;

  const bootstrapChannel = new Promise((resolve) => {
    window.addEventListener('message', (event) => {
      try {
        const url = new URL(event.origin);
        if (!url.hostname.endsWith('.google.com')) {
          return;
        }
      } catch (e) {
        return;
      }

      if (event.data.type === 'bootstrap') {
        resolve({
          port: event.ports[0],
          urlPatterns:
              event.data.urlPatterns.map((pattern) => new RegExp(pattern)),
        });
      }
    });
  });

  window.aistudio = window.aistudio || {
    handleFullscreenEsc: true,
    getHostUrl: async function() {
      const hostPort = (await bootstrapChannel).port;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        hostPort.postMessage(
            {type: 'get_host_url'},
            [channel.port2]);
        const port = channel.port1;
        port.onmessage = (message) => {
          resolve(message.data.url);
        };
      });
    },
    hasSelectedApiKey: async function() {
      const hostPort = (await bootstrapChannel).port;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        hostPort.postMessage(
            {type: 'has_selected_api_key'},
            [channel.port2]);
        const port = channel.port1;
        port.onmessage = (message) => {
          resolve(message.data);
        };
      });
    },
    openSelectKey: async function() {
      const hostPort = (await bootstrapChannel).port;
      const channel = new MessageChannel();
      hostPort.postMessage(
          {type: 'open_select_key'},
          [channel.port2]);
    },
    getModelQuota: async function(model) {
      const hostPort = (await bootstrapChannel).port;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        hostPort.postMessage(
            {type: 'get_model_quota', model},
            [channel.port2]);
        const port = channel.port1;
        port.onmessage = (message) => {
          resolve(message.data.modelQuota);
        };
      });
    },
  };

  const nativeFetch = window.fetch;

  /**
   * @param {string | URL | Request} resource The resource of the fetch request.
   * @param {RequestInit} options The options of the fetch request.
   * @return {Promise!} The promise of the fetch request.
   */
  async function fetch(resource, options) {
    const config = await bootstrapChannel;

    const request = resource instanceof Request ?
      resource.clone() :
      new Request(resource, options);

    if (!config.urlPatterns.some((pattern) => request.url.match(pattern))) {
      return nativeFetch(resource, options);
    }
    const hostPort = config.port;

    const channel = new MessageChannel();
    const port = channel.port1;
    let bodyBytes;
    const transfer = [channel.port2];
    const parts = [];
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength) {
      bodyBytes = buffer;
      transfer.push(bodyBytes);
    }
    hostPort.postMessage(
        {
          type: 'fetch',
          url: request.url,
          method: request.method,
          headers: [...request.headers.entries()],
          body: bodyBytes,
        },
        transfer);

    let streamController;
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    });
    let resolveReceive;
    const receivePromise = new Promise((resolve) => {
      resolveReceive = resolve;
    });
    port.onmessage = (message) => {
      switch (message.data.type) {
        case 'response':
          resolveReceive(new Response(body, {
            status: message.data.status,
            statusText: message.data.statusText,
            headers: new Headers(message.data.headers),
          }));
          break;
        case 'body':
          streamController.enqueue(message.data.data);
          break;
        case 'body_done':
          streamController.close();
          break;
      }
    };
    return receivePromise;
  }

  Object.defineProperty(window, 'fetch', {
    get: function() {
      return fetch;
    },
  });

  // See details in: https://github.com/angular/angular/issues/63064.
  function patchHistoryStateFunctionForAngular(originalFn, baseHref) {
    return (state, unused, url) => {
      if (typeof url === 'string' && !url.startsWith('blob:')) {
        url = baseHref + url;
      }
      return originalFn.apply(window.history, [state, unused, url]);
    };
  }

  const originalWebSocket = window.WebSocket;
  class ProxiedWebSocket extends EventTarget {
    /**
     * @param {string} url The url of the websocket.
     * @param {Object!} protocols The protocols of the websocket.
     */
    constructor(url, protocols) {
      super();
      this.url = url;
      this.protocols = protocols;

      this.open();
    }

    /** Opens the websocket. */
    async open() {
      const hostPort = (await bootstrapChannel).port;
      const channel = new MessageChannel();
      hostPort.postMessage(
          {type: 'websocket_open', url: this.url, protocols: this.protocols},
          [channel.port2]);
      this.port = channel.port1;
      this.port.onmessage = (message) => {
        if (message.data.type === 'close') {
          const event = new CloseEvent('close', {
            code: message.data.code,
            reason: message.data.reason,
            wasClean: message.data.wasClean,
          });
          if (this.onclose) {
            this.onclose(event);
          }
          this.dispatchEvent(event);
          return;
        } else if (message.data.type === 'open') {
          const event = new Event('open');
          if (this.onopen) {
            this.onopen(event);
          }
          this.dispatchEvent(event);
          return;
        } else if (message.data.type === 'message') {
          let data = message.data.data;
          if (message.data.messageType === 'text' || message.data.messageType === 'message') {
            data = new TextDecoder().decode(data);
          }
          const event = new MessageEvent('message', {
            data,
            type: message.data.messageType,
          });
          if (this.onmessage) {
            this.onmessage(event);
          }
          this.dispatchEvent(event);
          return;
        } else if (message.data.type === 'error') {
          const event = new ErrorEvent('error', {
            message: message.data.message,
          });
          if (this.onerror) {
            this.onerror(event);
          }
          this.dispatchEvent(event);
          return;
        }
        console.error('received unknown message in frame', event.data);
      };
    }
    /**
     * @param {string|ArrayBuffer!} data The data to send.
     */
    send(data) {
      if (typeof data === 'string') {
        this.port.postMessage({type: 'send', data});
      } else {
        this.port.postMessage({type: 'send', data}, [data.buffer]);
      }
    }

    /**
     * @param {number} code The code of the close event.
     * @param {string} reason The reason of the close event.
     */
    close(code, reason) {
      this.port.postMessage({type: 'close', code, reason});
    }
  }

  /**
   * @param {string} url The url of the websocket.
   * @param {Object!} protocols The protocols of the websocket.
   * @return {WebSocket!} The websocket.
   */
  function createWebSocket(url, protocols) {
    // This should come from the bootstrap channel, but we want this to
    // work for the synchronous constructor here.
    if (url.startsWith('wss://generativelanguage.googleapis.com/')) {
      return Reflect.construct(ProxiedWebSocket, [url, protocols]);
    }
    return Reflect.construct(originalWebSocket, [url, protocols]);
  }

  Object.defineProperty(window, 'WebSocket', {
    get: function() {
      const fn = createWebSocket;
      Object.keys(originalWebSocket).forEach((key) => {
        Object.defineProperty(fn, key, {
          value: originalWebSocket[key],
        });
      });
      return fn;
    },
  });

  async function instrumentErrorReporting() {
    const errors = [];
    let hostPort;

    function reportError(message) {
      if (!hostPort) {
        errors.push(message);
      } else {
        hostPort.postMessage({type: 'error', message: message}, message);
      }
    }

    function serialize(args) {
      return args.map((a) => {
        if (a instanceof Error || a instanceof ErrorEvent) {
          return a.message;
        }
        if(a instanceof CloseEvent) {
          return {code: a.code, reason: a.reason, wasClean: a.wasClean};
        }
        if( a instanceof Map) {
          return JSON.parse(JSON.stringify([...a.entries()]));
        }
        if( a instanceof Set) {
          return JSON.parse(JSON.stringify([...a.values()]));
        }
        if (a instanceof Object) {
          return JSON.parse(JSON.stringify(a));
        }
        return a;
      });
    }

    const originalConsole = window.console;
    const originalConsoleLog = window.console.log;
    const originalConsoleError = window.console.error;
    const originalConsoleWarn = window.console.warn;
    const originalConsoleDebug = window.console.debug;
    window.console = {
      ...originalConsole,
      log: (message, ...args) => {
        originalConsoleLog.apply(window.console, [message, ...args]);
        const combined = serialize([message, ...args]);
        reportError({type: 'console_log', message: combined });
      },
      debug: (message, ...args) => {
        originalConsoleDebug.apply(window.console, [message, ...args]);
        const combined = serialize([message, ...args]);
        reportError({type: 'console_debug', message: combined });
      },
      error: (message, ...args) => {
        originalConsoleError.apply(window.console, [message, ...args]);
        const combined = serialize([message, ...args]);
        reportError({type: 'console_error', message: combined });
      },
      warn: (message, ...args) => {
        originalConsoleWarn.apply(window.console, [message, ...args]);
        const combined = serialize([message, ...args]);
        reportError({type: 'console_warn', message: combined });
      },
    };

    window.onerror = (message, source, lineno, colno, error) => {
      reportError({type: 'error', message: serialize([message]), source, lineno, colno, error});
    };

    window.onunhandledrejection = (event) => {
      reportError({type: 'unhandledrejection', message: serialize([event.reason])});
    };

    window.alert = (message) => {
      reportError({type: 'alert', message: serialize([message]) });
    };

    hostPort = (await bootstrapChannel).port;
    for(const error of errors) {
      hostPort.postMessage({type: 'error', message: error});
    }
  }

  const availableFiles = new Set(window.APPLET_FILES || []);

  instrumentErrorReporting();

  const notifyLocationChange = async () => {
    const hostPort = (await bootstrapChannel).port;
    hostPort.postMessage({type: 'locationchange', href: location.href});
  };

  // Send initial state on load.
  notifyLocationChange();

  const originalPushState = history.pushState;
  history.pushState = (...args) => {
    originalPushState.apply(history, args);
    notifyLocationChange();
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = (...args) => {
    originalReplaceState.apply(history, args);
    notifyLocationChange();
  };
  window.addEventListener('popstate', (e) => {
    notifyLocationChange();
  });

  window.addEventListener('hashchange', async (e) =>{
    const config = await bootstrapChannel;
    const hostPort = config.port;
    hostPort.postMessage({type: 'hashchange', hash: window.location.hash});
    hostPort.postMessage({
      type: 'locationchange',
      href: location.href,
    });
  });

  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/html2canvas-pro';
  script.onload = () => {
    window.addEventListener('message', async (event) => {
      if (event.data?.type === 'capture-screenshot') {
        try {
          const canvas = await html2canvas(document.documentElement, {
            logging: false,
            useCORS: true,
            backgroundColor: null,
            scale: 1,
          });
          const hostPort = (await bootstrapChannel).port;
          hostPort.postMessage(
            {
              type: 'screenshot-result',
              dataUrl: canvas.toDataURL('image/png'),
              requestId: event.data.requestId,
              scrollX: document.body.scrollLeft,
              scrollY: document.body.scrollTop,
            },
          );
        } catch (e) {
          const hostPort = (await bootstrapChannel).port;
          hostPort.postMessage(
            {
              type: 'screenshot-error',
              error: e.message,
              requestId: event.data.requestId,
            });
        }
      }
    });
  };
  document.head.appendChild(script);

  const MAX_ANCESTOR_LEVEL = 3;
  const MAX_DESCENDANT_LEVEL = 3;

  function getElementSelector(el) {
    if (!el || el.nodeType !== 1) {
      return '';
    }
    const parts = [];
    while(el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'body') {
      let part = el.tagName.toLowerCase();
      if (el.id) {
        part += '#' + CSS.escape(el.id);
      }

      const parent = el.parentElement;
      if (parent) {
        let nth = 1;
        let prev = el.previousElementSibling;
        while(prev) {
          if (prev.tagName === el.tagName) {
            nth++;
          }
          prev = prev.previousElementSibling;
        }
        part += ':nth-of-type(' + nth + ')';
      }

      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function getDomTreeAsString(element, depth, maxDepth) {
    if (!element || element.nodeType !== 1 || depth > maxDepth) {
      return '';
    }
    const tagName = element.tagName.toLowerCase();
    let attrs = [];
    if (element.id) {
      attrs.push('id="' + element.id + '"');
    }
    if (element.classList.length > 0) {
      attrs.push('class="' + element.classList.value + '"');
    }
    const attrString = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

    let content = '';
    for (const node of element.childNodes) {
      if (node.nodeType === 1) { // Element node
        content += getDomTreeAsString(node, depth + 1, maxDepth);
      } else if (node.nodeType === 3) { // Text node
        content += node.textContent;
      }
    }

    return '<' + tagName + attrString + '>' + content + '</' + tagName + '>';
  }

  function getElementInfo(element) {
    const selector = getElementSelector(element);
    let levelsUp = 0;
    let root = element;
    while(levelsUp < MAX_ANCESTOR_LEVEL && root.parentElement && root.parentElement.tagName.toLowerCase() !== 'html') {
      root = root.parentElement;
      levelsUp++;
    }
    const domString = getDomTreeAsString(root, 0, levelsUp + MAX_DESCENDANT_LEVEL);
    const styles = window.getComputedStyle(element);
    const css = {};
    for (let i = 0; i < styles.length; i++) {
      const key = styles[i];
      css[key] = styles.getPropertyValue(key);
    }
    return { selector, domString, css };
  }

  const style = document.createElement('style');
  style.textContent =
    '.aistudio-hover-highlight { box-shadow: inset 0 0 0 0.5px white, inset 0 0 0 1.5px rgba(128,128,128,0.6) !important; }' +
    '.aistudio-active-highlight { box-shadow: inset 0 0 0 0.5px white, inset 0 0 0 1.5px #87a9ff !important; }' +
    '#aistudio-focus-mode-tag { position: absolute; display: none; background: #87a9ff; border-radius: 4px; border: 0.5px solid white; z-index: 10000; text-transform: lowercase; padding: 2px 4px; color: #32302c; font-family: Inter, sans-serif; font-size: 12px; font-style: normal; font-weight: 400; line-height: 16px; pointer-events: none; }' +
    '#aistudio-hover-mode-tag { position: absolute; display: none; background: rgba(128,128,128,0.6); border-radius: 4px; border: 0.5px solid white; z-index: 10000; text-transform: lowercase; padding: 2px 4px; color: white; font-family: Inter, sans-serif; font-size: 12px; font-style: normal; font-weight: 400; line-height: 16px; pointer-events: none; }';
  document.head.appendChild(style);

  let hoveredElement = null;
  let activeElement = null;
  let focusTag = null;
  let hoverTag = null;
  let resizeObserver = null;
  let designModeEnabled = false;
  let designModeStyle = null;
  let designModeOverlay = null;

  function ensureFocusTag() {
    if (!focusTag) {
      focusTag = document.createElement('div');
      focusTag.id = 'aistudio-focus-mode-tag';
      document.body.appendChild(focusTag);
    }
  }

  function cleanupActiveElement() {
    if (!activeElement) return;
    activeElement.classList.remove('aistudio-active-highlight');
    activeElement.removeAttribute('data-aistudio-tag-name');
    if (resizeObserver) {
      resizeObserver.unobserve(activeElement);
    }
    window.removeEventListener('resize', positionFocusTag);
    window.removeEventListener('scroll', positionFocusTag, true);
  }

  function positionFocusTag() {
    requestAnimationFrame(() => {
      if (!activeElement || !focusTag) return;
      focusTag.style.display = 'inline-flex';
      const rect = activeElement.getBoundingClientRect();
      focusTag.style.top = (rect.top + window.scrollY - focusTag.offsetHeight - 5) + 'px';
      focusTag.style.left = (rect.left + window.scrollX) + 'px';
    });
  }

  function positionHoverTag() {
    if (!hoveredElement || !hoverTag || hoveredElement === activeElement) {
      if (hoverTag) hoverTag.style.display = 'none';
      return;
    }
    requestAnimationFrame(() => {
      hoverTag.style.display = 'inline-flex';
      const rect = hoveredElement.getBoundingClientRect();
      hoverTag.style.top = (rect.top + window.scrollY - hoverTag.offsetHeight - 5) + 'px';
      hoverTag.style.left = (rect.left + window.scrollX) + 'px';
    });
  }

  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(() => {
      positionFocusTag();
    });
  }

  function setHoveredElement(element) {
    if (!designModeEnabled) return;

    if (!hoverTag) {
      hoverTag = document.createElement('div');
      hoverTag.id = 'aistudio-hover-mode-tag';
      document.body.appendChild(hoverTag);
    }

    if (hoveredElement && hoveredElement !== activeElement) {
      hoveredElement.classList.remove('aistudio-hover-highlight');
    }
    hoverTag.style.display = 'none';

    hoveredElement = element;

    if (hoveredElement && hoveredElement !== activeElement) {
      hoveredElement.classList.add('aistudio-hover-highlight');
      hoverTag.textContent = hoveredElement.tagName.toLowerCase();
      positionHoverTag();
    }
  }

  async function setActiveElement(element) {
    if (!designModeEnabled) return;

    ensureFocusTag();
    cleanupActiveElement();
    focusTag.style.display = 'none';

    // Clear hover from new active element if it was hovered
    if (element) {
      element.classList.remove('aistudio-hover-highlight');
    }

    activeElement = element;

    if (activeElement) {
      activeElement.setAttribute('data-aistudio-tag-name', activeElement.tagName);
      activeElement.classList.add('aistudio-active-highlight');
      focusTag.textContent = activeElement.tagName.toLowerCase();
      positionFocusTag();
      if (resizeObserver) {
        resizeObserver.observe(activeElement);
      }
      window.addEventListener('resize', positionFocusTag);
      window.addEventListener('scroll', positionFocusTag, true);

      // Notify host about selected element
      const info = getElementInfo(activeElement);
      window.parent.postMessage({
        type: 'element-selected',
        element: info,
      }, '*');
    }
  }

  function getElementAtPoint(x, y) {
    const elements = document.elementsFromPoint(x, y);
    for (const el of elements) {
      if (el.id === 'aistudio-focus-mode-tag' ||
          el.id === 'aistudio-hover-mode-tag' ||
          el.id === 'aistudio-design-mode-overlay') {
        continue;
      }
      return el;
    }
    return null;
  }

  function onMouseMove(e) {
    if (!designModeEnabled) return;
    const element = getElementAtPoint(e.clientX, e.clientY);
    setHoveredElement(element);
  }

  function onClick(e) {
    if (!designModeEnabled) return;
    e.preventDefault();
    e.stopPropagation();
    const element = getElementAtPoint(e.clientX, e.clientY);
    if (element && element !== document.body) {
      setActiveElement(element);
    }
  }

  function onKeyDown(e) {
    if (!designModeEnabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const element = document.activeElement;
      if (element && element !== document.body) {
        setActiveElement(element);
      }
    }
  }

  function enableDesignMode() {
    if (designModeEnabled) return;
    designModeEnabled = true;
    designModeStyle = document.createElement('style');
    designModeStyle.textContent =
      'button:disabled, input:disabled, select:disabled, textarea:disabled, ' +
      '[disabled], [aria-disabled="true"] { pointer-events: auto !important; }';
    document.head.appendChild(designModeStyle);
    designModeOverlay = document.createElement('div');
    designModeOverlay.id = 'aistudio-design-mode-overlay';
    designModeOverlay.style.cssText =
      'position: fixed; top: 0; left: 0; width: 100%; height: 100%; ' +
      'z-index: 9999; cursor: default; background: transparent;';
    designModeOverlay.addEventListener('mousemove', onMouseMove);
    designModeOverlay.addEventListener('mousedown', onClick);
    designModeOverlay.addEventListener('keydown', onKeyDown);
    document.body.appendChild(designModeOverlay);
  }

  function disableDesignMode() {
    if (!designModeEnabled) return;
    if (designModeOverlay) {
      designModeOverlay.removeEventListener('mousemove', onMouseMove);
      designModeOverlay.removeEventListener('mousedown', onClick);
      designModeOverlay.removeEventListener('keydown', onKeyDown);
      designModeOverlay.remove();
      designModeOverlay = null;
    }
    setHoveredElement(null);
    clearActiveElement();
    if (designModeStyle) {
      designModeStyle.remove();
      designModeStyle = null;
    }
    designModeEnabled = false;
  }

  function clearActiveElement() {
    ensureFocusTag();
    cleanupActiveElement();
    focusTag.style.display = 'none';
    activeElement = null;
  }

  window.addEventListener('message', async (event) => {
    if (event.data?.type === 'set-design-mode') {
      if (event.data.enabled) {
        enableDesignMode();
      } else {
        disableDesignMode();
      }
    } else if (event.data?.type === 'highlight-element-by-selector') {
      try {
        const selector = event.data.selector;
        if (selector) {
          const element = document.querySelector(selector);
          setActiveElement(element);
        } else {
          setActiveElement(null);
        }
      } catch (e) {
        setActiveElement(null);
      }
    } else if (event.data?.type === 'change-element-style') {
      try {
        const selector = event.data.selector;
        if (selector) {
          const element = document.querySelector(selector);
          if (element) {
            element.style.setProperty(
              event.data.property,
              event.data.value,
              'important',
            );
            positionFocusTag();
          }
        }
      } catch (e) {}
    }
  });

  window.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape' && window.aistudio?.handleFullscreenEsc) {
      const hostPort = (await bootstrapChannel).port;
      hostPort.postMessage({type: 'exit-fullscreen'});
    }
  });
})();
