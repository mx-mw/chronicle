((scope) => {
  'use strict';

  function escapeComponent(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/\r\n?/g, '\n')
      .replace(/\n/g, '\\n')
      .replace(/\|/g, '\\|');
  }

  function unescapeComponent(value) {
    let result = '';
    const input = String(value ?? '');
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character !== '\\' || index === input.length - 1) {
        result += character;
        continue;
      }
      const escaped = input[index + 1];
      if (escaped === 'n') result += '\n';
      else if (escaped === '\\' || escaped === '|') result += escaped;
      else result += `\\${escaped}`;
      index += 1;
    }
    return result;
  }

  function separatorIndex(line) {
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') escaped = true;
      else if (character === '|') return index;
    }
    return -1;
  }

  function formatPairLine(left, right) {
    return `${escapeComponent(left)} | ${escapeComponent(right)}`;
  }

  function parsePairText(value) {
    const pairs = [];
    const invalidLines = [];
    String(value ?? '').split('\n').forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      const separator = separatorIndex(line);
      const left = separator >= 0 ? unescapeComponent(line.slice(0, separator).trim()) : '';
      const right = separator >= 0 ? unescapeComponent(line.slice(separator + 1).trim()) : '';
      if (!left || !right) invalidLines.push(index + 1);
      else pairs.push([left, right]);
    });
    return { pairs, invalidLines };
  }

  function formatFactTopicLabel(item) {
    const topic = String(item?.topic || item?.topic_title || 'Topic').trim() || 'Topic';
    try {
      return `topic:${encodeURIComponent(topic)}`;
    } catch {
      let encoded = '';
      for (let index = 0; index < topic.length; index += 1) {
        encoded += topic.charCodeAt(index).toString(16).padStart(4, '0');
      }
      return `topic16:${encoded}`;
    }
  }

  function parseFactTopicLabel(value) {
    const raw = String(value ?? '').trim();
    if (raw.startsWith('topic16:')) {
      const encoded = raw.slice('topic16:'.length);
      if (encoded && encoded.length % 4 === 0 && /^[0-9a-f]+$/i.test(encoded)) {
        let topic = '';
        for (let index = 0; index < encoded.length; index += 4) {
          topic += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16));
        }
        if (topic.trim()) return { title: topic, topic };
      }
    }
    if (raw.startsWith('topic:')) {
      try {
        const topic = decodeURIComponent(raw.slice('topic:'.length)).trim();
        if (topic) return { title: topic, topic };
      } catch {
        // Treat a malformed marker as a new human-readable topic below.
      }
    }
    return { title: raw, topic: '' };
  }

  scope.ChronicleReviewLines = Object.freeze({
    formatFactTopicLabel,
    formatPairLine,
    parseFactTopicLabel,
    parsePairText,
  });
})(globalThis);
