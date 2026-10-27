import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupFoundryEnv } from "./helpers/foundry-env.mjs";

let renderer, handlers, frames, observers;

beforeEach(async () => {
    vi.resetModules();
    ({ hookHandlers: handlers } = await setupFoundryEnv());
    game.system = { version: "6.0.1" };
    CONFIG.ChatMessage = { dataModels: Object.fromEntries(
        ["attack", "damage", "healing", "check", "save", "generic"].map(type => [type, {}])) };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", callback => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", id => frames.delete(id));
    // Use real DOM observers, but disconnect them between tests on the shared document.
    observers = [];
    vi.stubGlobal("MutationObserver", class extends window.MutationObserver {
        constructor(callback) {
            super(callback);
            observers.push(this);
        }
    });
    renderer = await import("../src/utils/native-render.js");
    const { HooksUtility } = await import("../src/utils/hooks.js");
    HooksUtility.registerChatHooks();
});

afterEach(() => {
    observers.forEach(observer => observer.disconnect());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function flushFrame() {
    for (const id of [...frames.keys()]) {
        const callback = frames.get(id);
        if (!callback) continue;
        frames.delete(id);
        callback(0);
    }
}

function cards() {
    const original = document.createElement("li");
    original.className = "message";
    original.dataset.messageId = "attack";
    original.innerHTML = '<div class="message-content"><button>Roll</button></div>';
    const usage = document.createElement("li");
    usage.className = "message";
    usage.dataset.messageId = "usage";
    usage.innerHTML = '<div class="message-content"><section class="rsr-native-source" data-rsr-message-id="attack"></section></div>';
    // As renderNativeMessage registers the fold-ins it builds.
    renderer.markNativeSource(usage.querySelector(".rsr-native-source"));
    game.messages.set("attack", { id: "attack", type: "attack" });
    return { original, usage };
}

function render(original) {
    handlers.get("dnd5e.renderChatMessage")(game.messages.get("attack"), original);
}

const isHidden = original => original.classList.contains("rsr-native-combined-original");

it("hides a batch inserted after its rendering frame has already run", async () => {
    const { original, usage } = cards();
    render(original);
    // Foundry renders cards sequentially before inserting the entire batch. A later
    // unmanaged usage card can still be awaiting enrichment when this frame fires.
    flushFrame();
    document.body.append(usage, original);
    await Promise.resolve();
    flushFrame();

    expect(isHidden(original)).toBe(true);
    expect(original.querySelector(".message-content").childNodes).toHaveLength(0);
});

it("hides a late batch while frames remain stalled, even after all earlier fallback timers ran", async () => {
    const { original, usage } = cards();
    render(original);
    await vi.advanceTimersByTimeAsync(500);
    document.body.append(usage, original);
    await vi.advanceTimersByTimeAsync(100);

    expect(isHidden(original)).toBe(true);
});

it("restores an original after the usage card's deletion animation removes it", async () => {
    const { original, usage } = cards();
    document.body.append(usage, original);
    render(original);
    flushFrame();
    expect(isHidden(original)).toBe(true);
    ui.chat.updateMessage = vi.fn();

    handlers.get("deleteChatMessage")({ id: "usage", type: "usage" });
    flushFrame();
    // Foundry removes the card only after its 100 ms animation has finished.
    setTimeout(() => usage.remove(), 100);
    await vi.advanceTimersByTimeAsync(100);
    flushFrame();

    expect(isHidden(original)).toBe(false);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(game.messages.get("attack"));
});

it("observes cards adopted into a detached window while main-window frames are stalled", async () => {
    const { original, usage } = cards();
    const detachedDocument = document.implementation.createHTMLDocument("Detached chat");
    const detachedWindow = { document: detachedDocument };
    foundry.applications.detached = {
        querySelectorAll: selector => [
            ...document.querySelectorAll(selector), ...detachedDocument.querySelectorAll(selector)
        ]
    };
    // Production creates the window before moving already-rendered nodes into it.
    handlers.get("openDetachedWindow")?.("chat", detachedWindow);
    render(original);
    await vi.advanceTimersByTimeAsync(500);
    detachedDocument.body.append(usage, original);
    await vi.advanceTimersByTimeAsync(100);

    expect(isHidden(original)).toBe(true);
});

it("reconciles insertion after an earlier timer on clients without animation frames", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const { original, usage } = cards();
    render(original);
    setTimeout(() => document.body.append(usage, original), 0);
    renderer.scheduleReconcile();
    await vi.runAllTimersAsync();

    expect(isHidden(original)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

it("coalesces a burst and queries represented IDs only once, ignoring its own cleanup and unrelated DOM edits", async () => {
    const { original, usage } = cards();
    render(original);
    document.body.append(usage, original);
    // More messages must not multiply the source query.
    for (let i = 0; i < 50; i++) {
        const unrelated = original.cloneNode(true);
        unrelated.dataset.messageId = `unrelated-${i}`;
        document.body.append(unrelated);
    }
    for (let i = 0; i < 166; i++) renderer.scheduleReconcile();
    await Promise.resolve();
    const spy = vi.spyOn(document, "querySelectorAll");
    flushFrame();
    expect(isHidden(original)).toBe(true);
    expect(spy.mock.calls.filter(([selector]) => selector === ".rsr-native-source[data-rsr-message-id]")).toHaveLength(1);
    expect(spy.mock.calls.filter(([selector]) => selector === ".message[data-message-id]")).toHaveLength(1);

    // Neither clearing the original's controls nor normal page updates need a pass.
    original.classList.add("hovered");
    document.body.append(document.createElement("aside"));
    usage.querySelector(".rsr-native-source").append(document.createTextNode("Result"));
    await Promise.resolve();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

it("restores originals when the last detached representation closes and releases its observer", async () => {
    const { original, usage } = cards();
    const detachedDocument = document.implementation.createHTMLDocument("Detached chat");
    let open = true;
    foundry.applications.detached = {
        querySelectorAll: selector => [
            ...document.querySelectorAll(selector), ...(open ? detachedDocument.querySelectorAll(selector) : [])
        ]
    };
    handlers.get("openDetachedWindow")("chat", { document: detachedDocument });
    render(original);
    document.body.append(original);
    detachedDocument.body.append(usage);
    await Promise.resolve();
    flushFrame();
    expect(isHidden(original)).toBe(true);
    await Promise.resolve();
    ui.chat.updateMessage = vi.fn();

    // Foundry removes the window from its query registry before firing this hook.
    open = false;
    handlers.get("closeDetachedWindow")("chat");
    flushFrame();
    expect(isHidden(original)).toBe(false);
    expect(ui.chat.updateMessage).toHaveBeenCalledWith(game.messages.get("attack"));
    detachedDocument.body.replaceChildren();
    await Promise.resolve();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

it("leaves a card visible and settled when its own HTML copies a source marker for itself", async () => {
    const { original } = cards();
    // Foundry allows class and data-* attributes in message content. Such a marker
    // is not a fold-in RSR built, so it must not hide the card it sits in.
    original.querySelector(".message-content").innerHTML =
        '<section class="rsr-native-source" data-rsr-message-id="attack">Copied card</section>';
    const template = original.cloneNode(true);
    let current = original;
    ui.chat.updateMessage = vi.fn(() => {
        const replacement = template.cloneNode(true);
        render(replacement);
        current.replaceWith(replacement);
        current = replacement;
    });
    render(original);
    document.body.append(original);
    await Promise.resolve();
    for (let i = 0; i < 10; i++) {
        flushFrame();
        await Promise.resolve();
    }

    expect(isHidden(current)).toBe(false);
    expect(current.querySelector(".message-content").textContent).toBe("Copied card");
    expect(ui.chat.updateMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

function cardWithCopiedMarker(id, markerFor) {
    const card = document.createElement("li");
    card.className = "message";
    card.dataset.messageId = id;
    card.innerHTML = `<div class="message-content"><section class="rsr-native-source" data-rsr-message-id="${markerFor}">Copied</section></div>`;
    game.messages.set(id, { id, type: "usage" });
    return card;
}

it("never hides cards whose own HTML carries copied source markers, so two of them can't loop", async () => {
    // Each card claims to represent itself; restoring one used to re-hide the other.
    const cardsById = { first: cardWithCopiedMarker("first", "first"), second: cardWithCopiedMarker("second", "second") };
    const { first, second } = cardsById;
    // Restoring a card re-renders it, which re-inserts its copied marker.
    ui.chat.updateMessage = vi.fn(message => {
        const replacement = cardWithCopiedMarker(message.id, message.id);
        cardsById[message.id].replaceWith(replacement);
        cardsById[message.id] = replacement;
    });
    renderer.observeNativeSources(document);
    document.body.append(first);
    await Promise.resolve();
    flushFrame();
    document.body.append(second);
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        flushFrame();
    }

    expect(isHidden(cardsById.first)).toBe(false);
    expect(isHidden(cardsById.second)).toBe(false);
    expect(ui.chat.updateMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

it("ignores a copied marker for another card, even inside an original that gets hidden", async () => {
    // A's content copies a marker for B; a real fold-in represents A, and A precedes B.
    const { original, usage } = cards();
    original.querySelector(".message-content").innerHTML =
        '<section class="rsr-native-source" data-rsr-message-id="other">Copied</section>';
    const other = document.createElement("li");
    other.className = "message";
    other.dataset.messageId = "other";
    other.innerHTML = '<div class="message-content"><button>Roll</button></div>';
    game.messages.set("other", { id: "other", type: "damage" });
    render(original);
    document.body.append(usage, original, other);
    await Promise.resolve();
    flushFrame();

    expect(isHidden(original)).toBe(true);
    expect(isHidden(other)).toBe(false);
    expect(other.querySelector(".message-content").childNodes).toHaveLength(1);
});

function chatCard(id) {
    const card = document.createElement("li");
    card.className = "chat-message message";
    card.dataset.messageId = id;
    card.innerHTML = '<header class="message-header"><time class="message-timestamp"></time></header><div class="message-content"></div>';
    return card;
}

function chatLog() {
    const log = document.createElement("ol");
    log.className = "chat-log";
    document.body.append(log);
    return log;
}

it("drops the earlier copy as soon as Foundry posts a card again, keeping the one it still measures, with no frame, timer or saved message", async () => {
    const [log, notifications] = [chatLog(), chatLog()];
    const [first, repost, notification] = [1, 2, 3].map(() => chatCard("damage"));
    renderer.observeNativeSources(document);
    log.append(first);
    notifications.append(notification);
    await Promise.resolve();
    // Foundry's timestamp ticks put Text nodes in the same observer batch.
    first.querySelector(".message-timestamp").textContent = "now";
    log.append(repost);
    await Promise.resolve();

    expect(first.isConnected).toBe(false);
    expect(repost.isConnected).toBe(true);
    expect(notification.isConnected).toBe(true);
});

it("keeps the card a scrolled-back page prepends in date order and drops the stray Foundry had appended at the bottom", async () => {
    const log = chatLog();
    const [stray, newer, inOrder] = [chatCard("old"), chatCard("newer"), chatCard("old")];
    renderer.observeNativeSources(document);
    log.append(newer, stray);
    await Promise.resolve();
    log.prepend(inOrder);
    await Promise.resolve();

    expect(inOrder.isConnected).toBe(true);
    expect(stray.isConnected).toBe(false);
});

it("leaves cards with an empty message id alone, so two local-only cards both stay", async () => {
    const log = chatLog();
    const [first, second] = [chatCard(""), chatCard("")];
    renderer.observeNativeSources(document);
    log.append(first);
    await Promise.resolve();
    log.append(second);
    await Promise.resolve();

    expect(first.isConnected).toBe(true);
    expect(second.isConnected).toBe(true);
});

it("dedupes only the cards a chat log holds directly, not a copy quoted in an earlier message or a list outside a log", async () => {
    const log = chatLog();
    const quoting = chatCard("quoting");
    quoting.querySelector(".message-content").innerHTML = '<div class="message" data-message-id="damage"></div>';
    const list = document.createElement("ol");
    document.body.append(list);
    const [damage, listed, relisted] = [1, 2, 3].map(() => chatCard("damage"));
    renderer.observeNativeSources(document);
    log.append(quoting);
    list.append(listed);
    await Promise.resolve();
    log.append(damage);
    list.append(relisted);
    await Promise.resolve();

    expect(damage.isConnected).toBe(true);
    expect(quoting.querySelector('[data-message-id="damage"]')).not.toBeNull();
    expect(listed.isConnected).toBe(true);
    expect(relisted.isConnected).toBe(true);
});
