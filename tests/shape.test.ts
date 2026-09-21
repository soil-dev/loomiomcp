/**
 * Response shaping (src/loomio/shape.ts): the topics join, user / group
 * slimming, text truncation and canonical URL building. Fixture rows
 * follow the field names Loomio 3.8.1's serializers emit (verified
 * against live captures) with illustrative ids and names.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  commentUrl,
  discussionUrl,
  groupUrl,
  indexById,
  joinTopics,
  pollUrl,
  siteBaseUrl,
  slimGroup,
  slimGroups,
  slimUser,
  slimUsers,
  slugify,
  threadUrl,
  TOPIC_JOIN_FIELDS,
  topicJoinFields,
  truncateField,
  truncateText,
  compactHtml,
  truncateBody,
  htmlToText,
  stripBodyHtml,
} from "../src/loomio/shape.js";
import type { LoomioGroup, LoomioTopic, LoomioUser } from "../src/loomio/types.js";

afterEach(() => delete process.env["LOOMIO_API_BASE_URL"]);

/** A `topics[]` row as GET /b2/discussions side-loads it (TopicSerializer). */
const topic101: LoomioTopic = {
  id: 101,
  group_id: 7,
  items_count: 9,
  replies_count: 8,
  ranges: [[0, 8]],
  max_depth: 3,
  allow_concurrent_polls: false,
  allow_comments: true,
  allow_reactions: true,
  comment_length_max: null,
  active_polls_count: 1,
  last_activity_at: "2026-08-15T09:03:41.491Z",
  discarded_at: null,
  locked_at: null,
  locker_id: null,
  pinned_at: "2026-05-29T11:28:24.096Z",
  topicable_id: 501,
  topicable_type: "Discussion",
  members_count: 42,
  anonymous_polls_count: 0,
  closed_polls_count: 2,
  seen_by_count: 17,
  tags: ["budget", "2026"],
  reader_volume_email: "normal",
  reader_volume_push: "normal",
  last_read_at: null,
  dismissed_at: null,
  read_ranges: [],
  reader_inviter_id: null,
  reader_guest: false,
  reader_admin: false,
  discussion_id: 501,
};

describe("joinTopics", () => {
  it("folds exactly the TOPIC_JOIN_FIELDS onto the record that owns the topic", () => {
    const [joined] = joinTopics(
      [{ id: 501, key: "abcDEF12", title: "Budget", topic_id: 101 }],
      [topic101],
    );
    expect(joined).toMatchObject({
      id: 501,
      key: "abcDEF12",
      title: "Budget",
      topic_id: 101,
      items_count: 9,
      replies_count: 8,
      last_activity_at: "2026-08-15T09:03:41.491Z",
      locked_at: null,
      pinned_at: "2026-05-29T11:28:24.096Z",
      tags: ["budget", "2026"],
      members_count: 42,
      seen_by_count: 17,
      active_polls_count: 1,
      closed_polls_count: 2,
    });
    // Reader state and Loomio internals never cross over.
    for (const k of ["reader_volume_email", "read_ranges", "ranges", "max_depth", "topicable_id"]) {
      expect(joined).not.toHaveProperty(k);
    }
    expect(Object.keys(topicJoinFields(topic101)).sort()).toEqual([...TOPIC_JOIN_FIELDS].sort());
  });

  it("leaves a record untouched when its topic is missing (no fake zeros), and tolerates missing roots", () => {
    const [a, b] = joinTopics([{ id: 1, topic_id: 999 }, { id: 2 }], [topic101]);
    expect(a).toEqual({ id: 1, topic_id: 999 });
    expect(b).toEqual({ id: 2 });
    expect(joinTopics(undefined, undefined)).toEqual([]);
    expect(joinTopics([{ id: 3, topic_id: 101 }], undefined)).toEqual([{ id: 3, topic_id: 101 }]);
  });

  it("does not mutate its inputs", () => {
    const record = { id: 501, topic_id: 101 };
    joinTopics([record], [topic101]);
    expect(record).toEqual({ id: 501, topic_id: 101 });
    expect(topic101.reader_admin).toBe(false);
  });

  it("indexById maps ids to rows and is empty for a missing root", () => {
    expect(indexById([topic101]).get(101)).toBe(topic101);
    expect(indexById(undefined).size).toBe(0);
  });
});

describe("slimUser / slimUsers", () => {
  const ada: LoomioUser = {
    id: 202,
    name: "Ada Example",
    username: "ada",
    avatar_initials: "AE",
    avatar_kind: "uploaded",
    thumb_url: "/rails/active_storage/x.png",
    time_zone: "Europe/Prague",
    locale: "en",
    created_at: "2024-10-19T02:52:23.311Z",
    titles: { "7": "Treasurer" },
    delegates: {},
    email_verified: true,
    bot: false,
    email: "ada@example.org",
  };

  it("keeps id, name, username and nothing else by default", () => {
    expect(slimUser(ada)).toEqual({ id: 202, name: "Ada Example", username: "ada" });
  });

  it("includes email only when asked AND present", () => {
    expect(slimUser(ada, { includeEmail: true })).toEqual({
      id: 202,
      name: "Ada Example",
      username: "ada",
      email: "ada@example.org",
    });
    const { email: _e, ...noEmail } = ada;
    expect(slimUser(noEmail, { includeEmail: true })).not.toHaveProperty("email");
    expect(slimUser({ ...ada, email: "" }, { includeEmail: true })).not.toHaveProperty("email");
  });

  it("normalises missing name/username to null and handles a missing root", () => {
    expect(slimUser({ id: 1 })).toEqual({ id: 1, name: null, username: null });
    expect(slimUsers(undefined)).toEqual([]);
    expect(slimUsers([ada]).map((u) => u.id)).toEqual([202]);
  });
});

describe("slimGroup / slimGroups", () => {
  const group: LoomioGroup = {
    id: 7,
    key: "grpKEY01",
    handle: "finance-team",
    name: "Finance",
    full_name: "Example Org - Finance",
    description: "<p>Money things</p>",
    description_format: "html",
    logo_url: null,
    created_at: "2024-10-22T08:01:40.605Z",
    creator_id: 202,
    members_can_add_members: false,
    members_can_start_discussions: true,
    polls_count: 9,
    closed_polls_count: 7,
    discussions_count: 32,
    group_privacy: "closed",
    memberships_count: 12,
    discussion_privacy_options: "private_only",
    enabled: true,
    attachments: [],
    cover_url: "/x.png",
    is_visible_to_public: false,
    subscription: { plan: "free" },
    subgroups_count: 0,
    parent_id: 2,
    current_user_membership_id: 900,
  };

  it("keeps the identity, privacy, size and liveness fields only", () => {
    expect(slimGroup(group)).toEqual({
      id: 7,
      key: "grpKEY01",
      handle: "finance-team",
      name: "Finance",
      full_name: "Example Org - Finance",
      group_privacy: "closed",
      is_visible_to_public: false,
      discussion_privacy_options: "private_only",
      memberships_count: 12,
      discussions_count: 32,
      polls_count: 9,
      enabled: true,
      parent_id: 2,
    });
  });

  it("omits fields Loomio did not send rather than inventing undefined keys", () => {
    expect(slimGroup({ id: 1, name: "Bare" })).toEqual({ id: 1, name: "Bare" });
    expect(slimGroups(undefined)).toEqual([]);
  });
});

describe("truncateText", () => {
  it("max < 0 returns the full text", () => {
    expect(truncateText("hello world", -1)).toEqual({
      text: "hello world",
      truncated: false,
      chars: 11,
    });
  });

  it("max === 0 omits the text but reports its size", () => {
    expect(truncateText("hello", 0)).toEqual({ text: undefined, truncated: true, chars: 5 });
    expect(truncateText("", 0)).toEqual({ text: undefined, truncated: false, chars: 0 });
  });

  it("max > 0 cuts and flags; short text passes through", () => {
    expect(truncateText("hello world", 5)).toEqual({ text: "hello", truncated: true, chars: 11 });
    expect(truncateText("hi", 5)).toEqual({ text: "hi", truncated: false, chars: 2 });
    expect(truncateText("exact", 5)).toEqual({ text: "exact", truncated: false, chars: 5 });
  });

  it("never splits a surrogate pair", () => {
    // "ab" + U+1F600 (two UTF-16 units): cutting at 3 would leave a lone high surrogate.
    const r = truncateText("ab😀cd", 3);
    expect(r.text).toBe("ab");
    expect(r.truncated).toBe(true);
    expect(r.chars).toBe(6);
  });

  it("passes null and undefined through", () => {
    expect(truncateText(null, 10)).toEqual({ text: null, truncated: false, chars: 0 });
    expect(truncateText(undefined, 10)).toEqual({ text: undefined, truncated: false, chars: 0 });
  });
});

describe("truncateField", () => {
  const record = { id: 1, description: "0123456789", title: "T", count: 3 };

  it("cuts the field in a copy and adds <field>_truncated + <field>_chars", () => {
    expect(truncateField(record, "description", 4)).toEqual({
      id: 1,
      description: "0123",
      description_truncated: true,
      description_chars: 10,
      title: "T",
      count: 3,
    });
    expect(record.description).toBe("0123456789");
  });

  it("removes the field for max 0 and marks it omitted", () => {
    expect(truncateField(record, "description", 0)).toEqual({
      id: 1,
      description_omitted: true,
      description_chars: 10,
      title: "T",
      count: 3,
    });
  });

  it("adds no flags when nothing was cut, and ignores non-string / missing fields", () => {
    expect(truncateField(record, "description", 100)).toEqual(record);
    expect(truncateField(record, "description", -1)).toEqual(record);
    expect(truncateField(record, "count", 1)).toEqual(record);
    expect(truncateField(record, "missing", 1)).toEqual(record);
  });
});

describe("compactHtml", () => {
  it("strips every attribute except a link's href and an image's alt, and the whitespace between tags", () => {
    const stored =
      '<h2 id="agenda-for-the-meeting">Agenda for the meeting</h2>\n' +
      '<p>See <a target="_blank" href="https://example.org/notes" rel="nofollow ugc noreferrer noopener">the notes</a> ' +
      'and <span class="mention" data-mention-id="42">@ada</span>.</p>\n' +
      '<img src="https://example.org/a.png" alt="chart" width="600" />';
    expect(compactHtml(stored)).toBe(
      "<h2>Agenda for the meeting</h2>" +
        '<p>See <a href="https://example.org/notes">the notes</a> and <span>@ada</span>.</p>' +
        '<img alt="chart" />',
    );
  });

  it("normalises single-quoted and bare attribute values, keeps text and entities untouched", () => {
    expect(compactHtml("<a href='https://example.org/?a=1&amp;b=2'>x &amp; y</a>")).toBe(
      '<a href="https://example.org/?a=1&amp;b=2">x &amp; y</a>',
    );
    expect(compactHtml("<a href=https://example.org/p>p</a>")).toBe(
      '<a href="https://example.org/p">p</a>',
    );
    expect(compactHtml("<p>a  <b>b</b>\n  c</p>")).toBe("<p>a  <b>b</b>\n  c</p>");
    expect(compactHtml("plain text, no tags")).toBe("plain text, no tags");
  });
});

describe("truncateBody", () => {
  const link =
    '<a target="_blank" href="https://example.org/n" rel="nofollow ugc noreferrer noopener">notes</a>';
  const html = `<p>${link} ${"word ".repeat(30)}</p>`;

  it("compacts an HTML body that exceeds the cap before cutting it; <field>_chars is the ORIGINAL length", () => {
    const record = { id: 1, description: html, description_format: "html" };
    const r = truncateBody(record, "description", 60, "description_format");
    expect(r.description).toBe(
      `<p><a href="https://example.org/n">notes</a> ${"word ".repeat(30)}</p>`.slice(0, 60),
    );
    expect(r["description_truncated"]).toBe(true);
    expect(r["description_chars"]).toBe(html.length);
    expect(record.description).toBe(html);
  });

  it("a body that fits once compacted is returned compact and unflagged", () => {
    const record = { id: 1, description: html, description_format: "html" };
    const r = truncateBody(record, "description", html.length - 10, "description_format");
    expect(r.description).toBe(
      `<p><a href="https://example.org/n">notes</a> ${"word ".repeat(30)}</p>`,
    );
    expect(r).not.toHaveProperty("description_truncated");
    expect(r).not.toHaveProperty("description_chars");
  });

  it("leaves a body within the cap byte-for-byte, and never touches Markdown, full (-1) or omitted (0) bodies", () => {
    const short = { id: 1, description: html, description_format: "html" };
    expect(truncateBody(short, "description", html.length, "description_format")).toEqual(short);
    expect(truncateBody(short, "description", -1, "description_format")).toEqual(short);
    expect(truncateBody(short, "description", 0, "description_format")).toEqual({
      id: 1,
      description_omitted: true,
      description_chars: html.length,
      description_format: "html",
    });
    const md = {
      id: 2,
      body: `[notes](https://example.org/n) ${"word ".repeat(30)}`,
      body_format: "md",
    };
    const r = truncateBody(md, "body", 20, "body_format");
    expect(r.body).toBe(md.body.slice(0, 20));
    expect(r["body_truncated"]).toBe(true);
    const unknown = { id: 3, body: html };
    expect(truncateBody(unknown, "body", 20, "body_format").body).toBe(html.slice(0, 20));
  });
});

describe("htmlToText", () => {
  it("turns a Loomio-style body into plain text: blank line per block, dash per list item, br as newline, entities decoded, whitespace collapsed", () => {
    const stored =
      '<h2 id="agenda-goals">Agenda &amp; goals</h2>\n' +
      '<p>See <a target="_blank" href="https://example.org/notes" rel="nofollow ugc">the notes</a> ' +
      'and <span class="mention" data-mention-id="42">@ada</span>.</p>\n' +
      "<ul><li>Budget</li><li>Grants &#8212; Q3</li></ul>" +
      "<p>Line one<br>Line two&nbsp;&nbsp;end</p>";
    expect(htmlToText(stored)).toBe(
      "Agenda & goals\n\nSee the notes and @ada.\n\n- Budget\n- Grants — Q3\n\nLine one\nLine two end",
    );
  });

  it("keeps escaped markup as text, drops script/style wholesale, joins table cells with spaces and rows with newlines", () => {
    expect(htmlToText("<p>use &lt;b&gt; sparingly</p>")).toBe("use <b> sparingly");
    expect(htmlToText("<p>x</p><style>.a{color:red}</style><script>1<2</script><p>y</p>")).toBe(
      "x\n\ny",
    );
    expect(
      htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"),
    ).toBe("a b\nc d");
  });

  it("passes plain text through and yields '' for markup-only input", () => {
    expect(htmlToText("plain text, no tags")).toBe("plain text, no tags");
    expect(htmlToText("<p></p>\n<p>  </p>")).toBe("");
    expect(htmlToText("")).toBe("");
  });
});

describe("stripBodyHtml", () => {
  const html = {
    id: 1,
    description: "<p>Hello <b>there</b></p><p>Bye</p>",
    description_format: "html",
  };

  it("converts an HTML body to text in a copy and marks the format 'text'", () => {
    expect(stripBodyHtml(html, "description", "description_format")).toEqual({
      id: 1,
      description: "Hello there\n\nBye",
      description_format: "text",
    });
    expect(html.description).toBe("<p>Hello <b>there</b></p><p>Bye</p>");
    expect(html.description_format).toBe("html");
  });

  it("leaves Markdown, nulled (discarded), missing and format-less bodies alone", () => {
    const md = { id: 2, description: "# Hello\n\n<br> inline", description_format: "md" };
    expect(stripBodyHtml(md, "description", "description_format")).toEqual(md);
    const discarded = { id: 3, description: null, description_format: "html" };
    expect(stripBodyHtml(discarded, "description", "description_format")).toEqual(discarded);
    expect(stripBodyHtml({ id: 4 }, "description", "description_format")).toEqual({ id: 4 });
    const unknown = { id: 5, description: "<p>x</p>" };
    expect(stripBodyHtml(unknown, "description", "description_format")).toEqual(unknown);
  });

  it("composes with truncateBody: the cap lands on the text and <field>_chars counts the text", () => {
    const long = { id: 6, details: `<p>${"word ".repeat(50)}</p>`, details_format: "html" };
    const stripped = stripBodyHtml(long, "details", "details_format");
    const text = "word ".repeat(50).trim();
    expect(stripped.details).toBe(text);
    const r = truncateBody(stripped, "details", 20, "details_format");
    expect(r.details).toBe(text.slice(0, 20));
    expect(r["details_truncated"]).toBe(true);
    expect(r["details_chars"]).toBe(text.length);
    expect(r["details_format"]).toBe("text");
    const omitted = truncateBody(stripped, "details", 0, "details_format");
    expect(omitted).not.toHaveProperty("details");
    expect(omitted["details_omitted"]).toBe(true);
    expect(omitted["details_chars"]).toBe(text.length);
  });
});

describe("URLs", () => {
  it("siteBaseUrl strips /api (and trailing slashes) from the configured base", () => {
    expect(siteBaseUrl()).toBe("https://www.loomio.com");
    process.env["LOOMIO_API_BASE_URL"] = "https://loomio.example.org/api/";
    expect(siteBaseUrl()).toBe("https://loomio.example.org");
    process.env["LOOMIO_API_BASE_URL"] = "https://loomio.example.org/deep/api";
    expect(siteBaseUrl()).toBe("https://loomio.example.org/deep");
    process.env["LOOMIO_API_BASE_URL"] = "http://localhost:3000";
    expect(siteBaseUrl()).toBe("http://localhost:3000");
  });

  it("slugify approximates Rails parameterize", () => {
    expect(slugify("Budget 2026: what's next?")).toBe("budget-2026-what-s-next");
    expect(slugify("  Émilie & Zoë — café ")).toBe("emilie-zoe-cafe");
    expect(slugify("snake_case_ok")).toBe("snake_case_ok");
    expect(slugify("日本語のみ")).toBe("");
    expect(slugify(null)).toBe("");
    expect(slugify(undefined)).toBe("");
  });

  it("discussionUrl: /d/{key}[/{slug}] with cosmetic slug, no slug when it would be empty", () => {
    expect(discussionUrl("abcDEF12", { title: "Budget 2026" })).toBe(
      "https://www.loomio.com/d/abcDEF12/budget-2026",
    );
    expect(discussionUrl("abcDEF12")).toBe("https://www.loomio.com/d/abcDEF12");
    expect(discussionUrl("abcDEF12", { title: "日本語" })).toBe(
      "https://www.loomio.com/d/abcDEF12",
    );
  });

  it("deep links use Loomio's own no-slug query form (comment_id wins over sequence_id)", () => {
    expect(discussionUrl("abcDEF12", { title: "T", sequence_id: 7 })).toBe(
      "https://www.loomio.com/d/abcDEF12?sequence_id=7",
    );
    expect(discussionUrl("abcDEF12", { title: "T", sequence_id: 7, comment_id: 55 })).toBe(
      "https://www.loomio.com/d/abcDEF12?comment_id=55",
    );
    expect(commentUrl({ type: "Discussion", key: "abcDEF12" }, 55)).toBe(
      "https://www.loomio.com/d/abcDEF12?comment_id=55",
    );
    expect(commentUrl({ type: "Poll", key: "pollKEY9" }, 55)).toBe(
      "https://www.loomio.com/p/pollKEY9?comment_id=55",
    );
    expect(commentUrl({ type: "Comment", key: "x" }, 1)).toBeUndefined();
  });

  it("pollUrl: /p/{key}[/{slug}]", () => {
    expect(pollUrl("pollKEY9", { title: "Adopt the budget?" })).toBe(
      "https://www.loomio.com/p/pollKEY9/adopt-the-budget",
    );
    expect(pollUrl("pollKEY9", { sequence_id: 3 })).toBe(
      "https://www.loomio.com/p/pollKEY9?sequence_id=3",
    );
  });

  it("threadUrl dispatches on topicable_type and refuses to guess", () => {
    expect(threadUrl("Discussion", "abcDEF12", { title: "T" })).toBe(
      "https://www.loomio.com/d/abcDEF12/t",
    );
    expect(threadUrl("Poll", "pollKEY9")).toBe("https://www.loomio.com/p/pollKEY9");
    expect(threadUrl("Discussion", undefined)).toBeUndefined();
    expect(threadUrl("Something", "k")).toBeUndefined();
  });

  it("groupUrl prefers the handle, falls back to /g/{key}[/{slug}], and gives up gracefully", () => {
    expect(groupUrl({ handle: "finance-team", key: "grpKEY01", name: "Finance" })).toBe(
      "https://www.loomio.com/finance-team",
    );
    expect(groupUrl({ handle: null, key: "grpKEY01", name: "Finance Team" })).toBe(
      "https://www.loomio.com/g/grpKEY01/finance-team",
    );
    expect(groupUrl({ key: "grpKEY01" })).toBe("https://www.loomio.com/g/grpKEY01");
    expect(groupUrl({})).toBeUndefined();
  });

  it("URL-encodes keys and handles", () => {
    expect(discussionUrl("a b")).toBe("https://www.loomio.com/d/a%20b");
    expect(groupUrl({ handle: "team/x" })).toBe("https://www.loomio.com/team%2Fx");
  });

  it("follows LOOMIO_API_BASE_URL", () => {
    process.env["LOOMIO_API_BASE_URL"] = "https://loomio.example.org/api";
    expect(discussionUrl("abcDEF12")).toBe("https://loomio.example.org/d/abcDEF12");
  });
});
