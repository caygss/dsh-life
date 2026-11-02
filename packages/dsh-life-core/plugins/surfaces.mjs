/**
 * The surface registry.
 *
 * The host knows exactly one thing about a plugin capability: which *surface* it
 * touches. Capability names are free ("say_hello", "now_playing", "send_qq_file");
 * surfaces are a closed set, because a surface is the axis every whitelist is
 * written on. A name the host has never seen costs nothing to add later; a surface
 * it cannot fence costs a review of everything that trusts it.
 *
 * Three states, and the difference is the whole point:
 * implemented - the host knows how to fence it, so the plugin may be enabled
 * reserved - already decided to be coming (physical ports, the screen, a whole
 * VM) but nothing implements it yet: the install is refused with a
 * name that says "not yet", not a shrug
 * unknown - the manifest is talking about something never planned; also
 * refused, with a different code, so a typo is not mistaken for a
 * roadmap item
 *
 * Reserved is never a grant. A reserved surface appears in no whitelist, so the agent
 * cannot reach it by declaring it.
 */
export const IMPLEMENTED_SURFACES = Object.freeze([
  'tool',
  'inbound',
  'outbound',
  'exec',
  'fs',
  'net',
  'secret',
 // 宿主把「助手的记忆」这一层交出去的门。声明了它，宿主才把
 // 记忆服务（读、写、修订、撤回）交给这个插件；没声明就只是拿不到，不会静默降级成空对象。
  'memory',
 // 宿主把「助手自己的时刻」交出去的门。声明了它，插件才能替助手定下
 // "过十分钟再问你" / "19 点记着吃饭"；到点由助手的循环叫醒助手，不是插件自己开定时器。
  'schedule',
  // 宿主把「画一张」交出去的门。声明了它，宿主才把生图服务交给插件——
  // 那张图由外部服务画，key 在宿主这一侧，插件看不见。
  'image',
 // （号池）：宿主把「把一份账号文件交给生图号池」交出去的门。声明了它，宿主才把
 // 号池服务交给插件——文件字节由宿主读、宿主发，从不进助手的上下文；import key 不经过插件。
 // 这只手只属于"装了原生生图插件"的那套链路，所以它同时声明 requires（见 manifest）。
  'image-pool',
]);

/** Decided, documented, not implemented. Ordered by the decision that reserved it. */
export const RESERVED_SURFACES = Object.freeze([
  'device',
  'display',
  'vm',
]);

export const SURFACE_STATE = Object.freeze({
  IMPLEMENTED: 'implemented',
  RESERVED: 'reserved',
  UNKNOWN: 'unknown',
});

/** One line per surface: what the host actually gives away. Used in receipts and errors. */
export const SURFACE_DOORS = Object.freeze({
  tool: "the agent's tool table gains one action it can call",
  inbound: "may hand an outside message to the host gate, which decides whether the agent hears it",
  outbound: 'may send an artifact out through an authorized channel',
  exec: 'may start a one-shot process inside the sandbox',
  fs: 'may read or write the host directories it was granted',
 // （联网）：这道门真的给出去的不是通用 fetch，是宿主自己的 Search / Fetch
 // 两个动作；出口和 allowlist 都在宿主那一侧，插件只能照它做。
  net: "may search the web and open a page through the host's own search/fetch allowlist",
  secret: 'may use a named credential inside the plugin only',
  memory: "may read and write the agent's own memories (note / recall / unpack / revise / withdraw)",
  schedule: "may set, list and cancel its own moments (a reminder that its own loop fires)",
  image: 'may ask the host to paint one picture (the picture is drawn off-machine; the key never leaves the host)',
  'image-pool': 'may hand an account file to the image service pool (the host reads it; bytes never enter the agent context, keys stay on the host)',
  device: 'physical ports',
  display: "the screen you look at the agent through",
  vm: 'a whole guest machine',
});

export function surfaceState(surface) {
  if (typeof surface !== 'string' || surface === '') return SURFACE_STATE.UNKNOWN;
  if (IMPLEMENTED_SURFACES.includes(surface)) return SURFACE_STATE.IMPLEMENTED;
  if (RESERVED_SURFACES.includes(surface)) return SURFACE_STATE.RESERVED;
  return SURFACE_STATE.UNKNOWN;
}

export function isImplementedSurface(surface) {
  return surfaceState(surface) === SURFACE_STATE.IMPLEMENTED;
}

/**
 * Resolves every capability of a manifest against the registry.
 * Returns [{name, surface, state, door}] in declaration order so a refusal can name
 * the exact capability and surface that blocked it.
 */
export function resolveCapabilities(manifest) {
  const list = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
  return list.map((capability) => {
    const surface = capability?.surface;
    return {
      name: capability?.name,
      surface,
      state: surfaceState(surface),
      door: SURFACE_DOORS[surface] ?? null,
    };
  });
}
