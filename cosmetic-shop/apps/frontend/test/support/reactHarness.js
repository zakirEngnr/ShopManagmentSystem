// A minimal React test renderer.
//
// WHY THIS EXISTS
//
// The frontend has no browser and no DOM implementation is installed, and no
// dependency may be added. `react-dom/server` renders markup but never runs
// `useEffect`, so a server render of a page can only ever show the loading
// state: it can never exercise a click, a state transition or an API call.
//
// This file installs a hook dispatcher into React and drives the component
// directly. The component under test is the REAL one, with the REAL API
// helpers; only the transport is replaced (see expenseApiStub.js).
//
// WHAT THIS IS NOT
//
//   * it is not a browser: there is no layout, no CSS and no real event
//     delegation - a "click" is a direct call of the element's onClick prop;
//   * it is not React: effects run synchronously at the end of a render
//     instead of after the paint, updates are flushed by the test instead of
//     by the scheduler, and there is no concurrent rendering;
//   * it does not implement Suspense, portals, context or error boundaries.
//
// Every limitation above is a reason to keep the assertions in this
// repository focused on WHAT the component does (which request it sends,
// which rows it shows, which message the user is given) and not on HOW it
// looks.
import React from 'react';

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const FORWARD_REF = Symbol.for('react.forward_ref');
const MEMO = Symbol.for('react.memo');
const FRAGMENT = Symbol.for('react.fragment');

/** True when the dependency list of a hook changed (React's Object.is rule). */
function depsChanged(previous, next) {
  if (previous === undefined || next === undefined) return true;
  if (previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return true;
  }
  return false;
}

/**
 * Render a function component and expose its rendered tree.
 *
 * @param {Function} Component - The function component under test.
 * @param {object} [props] - The props of the component.
 * @returns {object} The harness.
 */
export function createHarness(Component, props = {}) {
  let hooks = [];
  let hookIndex = 0;
  let dirty = false;
  let tree = null;
  let renderCount = 0;
  let currentProps = props;
  let idCounter = 0;

  const dispatcher = {
    useState(initial) {
      const index = hookIndex++;
      if (hooks.length <= index) {
        hooks[index] = { state: typeof initial === 'function' ? initial() : initial };
      }
      const hook = hooks[index];
      const setState = (update) => {
        const next = typeof update === 'function' ? update(hook.state) : update;
        if (Object.is(next, hook.state)) return;
        hook.state = next;
        dirty = true;
      };
      return [hook.state, setState];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (hooks.length <= index) hooks[index] = { ref: { current: initial } };
      return hooks[index].ref;
    },
    useMemo(factory, deps) {
      const index = hookIndex++;
      if (hooks.length <= index) hooks[index] = { memo: undefined, deps: undefined, has: false };
      const hook = hooks[index];
      if (!hook.has || depsChanged(hook.deps, deps)) {
        hook.memo = factory();
        hook.deps = deps;
        hook.has = true;
      }
      return hook.memo;
    },
    useCallback(callback, deps) {
      const index = hookIndex++;
      if (hooks.length <= index) hooks[index] = { callback: undefined, deps: undefined, has: false };
      const hook = hooks[index];
      if (!hook.has || depsChanged(hook.deps, deps)) {
        hook.callback = callback;
        hook.deps = deps;
        hook.has = true;
      }
      return hook.callback;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (hooks.length <= index) hooks[index] = { effect: undefined, deps: undefined, has: false, cleanup: undefined };
      const hook = hooks[index];
      if (!hook.has || depsChanged(hook.deps, deps)) {
        hook.pending = effect;
        hook.deps = deps;
        hook.has = true;
        hook.changed = true;
      }
    },
    useLayoutEffect(effect, deps) { dispatcher.useEffect(effect, deps); },
    useInsertionEffect(effect, deps) { dispatcher.useEffect(effect, deps); },
    useId() { idCounter += 1; return `:r${idCounter}:`; },
    useContext() { return undefined; },
    useDebugValue() {},
    useImperativeHandle() {},
    useTransition() { return [false, (scope) => scope()]; },
    useDeferredValue(value) { return value; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    useEffectEvent(callback) { return callback; },
    useOptimistic(state) { return [state, () => {}]; },
    useActionState(_action, initial) { return [initial, () => {}, false]; },
    use(usable) { return typeof usable === 'function' ? usable() : usable; },
    useMemoCache() { return () => {}; },
  };

  /** Commit the effects whose dependencies changed: cleanup first, then effect. */
  function runEffects() {
    for (const hook of hooks) {
      if (!hook || !hook.changed || !hook.pending) continue;
      hook.changed = false;
      if (typeof hook.cleanup === 'function') {
        hook.cleanup();
        hook.cleanup = undefined;
      }
      const result = hook.pending();
      if (typeof result === 'function') hook.cleanup = result;
      hook.pending = undefined;
    }
  }

  function render() {
    const previousDispatcher = internals.H;
    internals.H = dispatcher;
    hookIndex = 0;
    dirty = false;
    try {
      tree = Component(currentProps);
      renderCount += 1;
    } finally {
      internals.H = previousDispatcher;
    }
    runEffects();
  }

  render();

  /** Run a function with the harness dispatcher installed. */
  function withDispatcher(scope) {
    const previousDispatcher = internals.H;
    internals.H = dispatcher;
    try {
      return scope();
    } finally {
      internals.H = previousDispatcher;
    }
  }

  return {
    /** The current rendered element tree. */
    get tree() { return tree; },
    /** How many times the component was rendered. */
    get renderCount() { return renderCount; },

    /** Replace some props and render again. */
    setProps(nextProps) {
      currentProps = { ...currentProps, ...nextProps };
      this.flush();
    },

    /** Render again while a state update is pending. */
    flush() {
      let guard = 0;
      while (dirty && guard < 50) {
        guard += 1;
        render();
      }
    },

    /** Wait for the pending promises and render every state update they cause. */
    async settle(rounds = 40) {
      for (let round = 0; round < rounds; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (dirty) this.flush();
        else break;
      }
    },

    /** Run every effect cleanup, as an unmount would. */
    unmount() {
      for (const hook of hooks) {
        if (hook && typeof hook.cleanup === 'function') hook.cleanup();
      }
    },

    /** Every host element of the rendered tree. */
    collect() {
      return withDispatcher(() => collectHostElements(tree));
    },

    /**
     * The host elements whose text matches.
     *
     * @param {string|Function} matcher - A text, or a predicate on the text.
     * @param {string} [tag] - Restrict the result to this tag name.
     */
    findByText(matcher, tag) {
      return withDispatcher(() => findByText(tree, matcher, tag));
    },

    /** The visible text of the whole tree. */
    text() {
      return withDispatcher(() => textOf(tree));
    },
  };
}

/**
 * Every host element (a tag name) of a rendered tree.
 *
 * Nested function components are rendered so that the elements they produce
 * can be found as well.
 */
export function collectHostElements(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectHostElements(child, out);
    return out;
  }
  if (!React.isValidElement(node)) return out;

  const type = node.type;

  if (typeof type === 'string') {
    out.push(node);
    collectHostElements(node.props?.children, out);
    return out;
  }
  if (type === FRAGMENT || type === React.Fragment) {
    collectHostElements(node.props?.children, out);
    return out;
  }
  if (type && type.$$typeof === FORWARD_REF) {
    collectHostElements(type.render(node.props, null), out);
    return out;
  }
  if (type && type.$$typeof === MEMO) {
    collectHostElements(type.type(node.props), out);
    return out;
  }
  if (typeof type === 'function') {
    collectHostElements(type(node.props), out);
    return out;
  }
  return out;
}

/** The visible text of an element. */
export function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!React.isValidElement(node)) return '';
  return textOf(node.props?.children);
}

/** The host elements of a tree whose text matches. */
export function findByText(tree, matcher, tag) {
  const matches = typeof matcher === 'string'
    ? (text) => text.trim() === matcher
    : matcher;
  return collectHostElements(tree).filter((element) => {
    if (tag && element.type !== tag) return false;
    return matches(textOf(element));
  });
}

export default { createHarness, collectHostElements, textOf, findByText };
