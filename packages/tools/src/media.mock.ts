import { defineTool, type ToolDef } from "@agentdesk/protocol";
import { z } from "zod";

/**
 * In-memory media domain, used to prove the harness end-to-end before any real
 * integration exists. Week 3 replaces the storage with a real player adapter;
 * the tool contract (`name` + schema + result shape) is what stays stable.
 */

interface Track {
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  tags: string[];
}

const CATALOG: readonly Track[] = [
  { id: "t-001", title: "晴天", artist: "周杰伦", durationSec: 269, tags: ["pop", "chinese", "nostalgic"] },
  { id: "t-002", title: "七里香", artist: "周杰伦", durationSec: 299, tags: ["pop", "chinese", "summer"] },
  { id: "t-003", title: "夜曲", artist: "周杰伦", durationSec: 226, tags: ["pop", "chinese", "night"] },
  { id: "t-004", title: "Highway to Hell", artist: "AC/DC", durationSec: 208, tags: ["rock", "driving"] },
  { id: "t-005", title: "On the Road Again", artist: "Willie Nelson", durationSec: 158, tags: ["country", "driving"] },
  { id: "t-006", title: "Lo-fi Beats Vol.1", artist: "Chillhop", durationSec: 3600, tags: ["lofi", "focus", "commute"] },
  { id: "t-007", title: "Podcast: 汽车科技早知道", artist: "AutoFM", durationSec: 2100, tags: ["podcast", "tech", "commute"] },
];

const byTag: Record<string, string[]> = {
  commute: ["lofi", "driving", "commute"],
  focus: ["lofi", "focus"],
  driving: ["driving", "rock"],
  night: ["night"],
};

interface MediaState {
  nowPlaying: Track | null;
  playing: boolean;
  volume: number;
  window: "open" | "closed";
}

function freshState(): MediaState {
  return { nowPlaying: null, playing: false, volume: 6, window: "closed" };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function createMockMediaTools(): ToolDef[] {
  const state = freshState();

  const search = defineTool({
    name: "search_media",
    description:
      "Search the media catalogue by free text, artist, or a situational mood tag (commute / focus / driving / night). Returns up to 5 tracks.",
    risk: "safe",
    parameters: z.object({
      query: z.string().optional().describe("Free-text title fragment"),
      artist: z.string().optional().describe("Artist name"),
      mood: z
        .enum(["commute", "focus", "driving", "night"])
        .optional()
        .describe("Situational tag, use when the user describes a scene"),
    }),
    async run(args) {
      let results = CATALOG.filter((track) => {
        if (args.query !== undefined && !track.title.includes(args.query)) return false;
        if (args.artist !== undefined && track.artist !== args.artist) return false;
        if (args.mood !== undefined) {
          const tags = byTag[args.mood] ?? [];
          if (!track.tags.some((tag) => tags.includes(tag))) return false;
        }
        return true;
      });
      if (args.query === undefined && args.artist === undefined && args.mood === undefined) {
        results = CATALOG.slice(0, 5);
      }
      return {
        ok: true,
        output: json(results.slice(0, 5).map(({ id, title, artist }) => ({ id, title, artist }))),
        meta: { count: results.length },
      };
    },
  });

  const play = defineTool({
    name: "play",
    description: "Start playback of a track id returned by search_media.",
    risk: "safe",
    parameters: z.object({ trackId: z.string().describe("Track id, e.g. t-001") }),
    async run(args) {
      const track = CATALOG.find((candidate) => candidate.id === args.trackId);
      if (track === undefined) {
        return { ok: false, output: `no such track: ${args.trackId}` };
      }
      state.nowPlaying = track;
      state.playing = true;
      return { ok: true, output: json({ nowPlaying: track.title, artist: track.artist }) };
    },
  });

  const pause = defineTool({
    name: "pause",
    description: "Pause or resume the current playback.",
    risk: "safe",
    parameters: z.object({ resume: z.boolean().default(false) }),
    async run(args) {
      state.playing = args.resume;
      return { ok: true, output: json({ playing: state.playing }) };
    },
  });

  const next = defineTool({
    name: "next",
    description: "Skip to the next track in the current queue.",
    risk: "safe",
    parameters: z.object({}),
    async run() {
      if (state.nowPlaying === null) {
        return { ok: false, output: "nothing is playing" };
      }
      const index = CATALOG.findIndex((track) => track.id === state.nowPlaying?.id);
      const following = CATALOG[(index + 1) % CATALOG.length];
      if (following === undefined) {
        return { ok: false, output: "queue is empty" };
      }
      state.nowPlaying = following;
      state.playing = true;
      return { ok: true, output: json({ nowPlaying: following.title }) };
    },
  });

  const nowPlaying = defineTool({
    name: "get_now_playing",
    description: "Read the current playback state (track, artist, playing, volume).",
    risk: "safe",
    parameters: z.object({}),
    async run() {
      return {
        ok: true,
        output: json({
          nowPlaying: state.nowPlaying?.title ?? null,
          artist: state.nowPlaying?.artist ?? null,
          playing: state.playing,
          volume: state.volume,
        }),
      };
    },
  });

  const setVolume = defineTool({
    name: "set_volume",
    description: "Set the media volume, 0-20.",
    risk: "safe",
    parameters: z.object({ level: z.number().int().min(0).max(20) }),
    async run(args) {
      state.volume = args.level;
      return { ok: true, output: json({ volume: state.volume }) };
    },
  });

  // Vehicle control: irreversible, so it must go through the approval gate.
  const setWindow = defineTool({
    name: "set_window",
    description:
      "Open or close the driver window. Physically acts on the vehicle — requires explicit user confirmation.",
    risk: "confirm",
    parameters: z.object({ action: z.enum(["open", "close"]) }),
    async run(args) {
      state.window = args.action === "open" ? "open" : "closed";
      return { ok: true, output: json({ window: state.window }) };
    },
  });

  return [search, play, pause, next, nowPlaying, setVolume, setWindow];
}
