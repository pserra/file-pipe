const P2P_CONFIG = {
  ...(window.FILE_PIPE_P2P_CONFIG || { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
};

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sendChannelJson(channel, payload) {
  if (channel?.readyState !== "open") return false;
  try {
    channel.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    if (
      error?.name === "InvalidStateError"
      || String(error?.message || "").includes("RTCDataChannel.readyState")
      || String(error?.message || "").includes("readyState is not 'open'")
    ) {
      return false;
    }
    throw error;
  }
}

async function waitForIceGatheringComplete(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", checkState);
      resolve();
    }, 10000);
    const checkState = () => {
      if (peer.iceGatheringState === "complete") {
        clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", checkState);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
