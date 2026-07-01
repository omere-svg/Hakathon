import { Fragment, type ReactNode } from 'react';
import { CopyIcon } from './icons';

/** Minimal, safe markdown → React. Enough to mirror Maestro's rich tutor turns. */

function inline(text: string, keyBase: string): ReactNode[] {
  // Split on **bold** and `code`, keeping delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    const key = `${keyBase}-${i}`;
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={key}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={key} className="inline-code">{p.slice(1, -1)}</code>;
    return <Fragment key={key}>{p}</Fragment>;
  });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang || 'Text'}</span>
        <button
          type="button"
          className="codeblock-copy"
          onClick={() => navigator.clipboard?.writeText(code)}
        >
          <CopyIcon /> Copy Code
        </button>
      </div>
      <pre className="codeblock-body">
        <code>
          {lines.map((ln, i) => (
            <span className="code-line" key={i}>
              <span className="code-ln">{i + 1}</span>
              <span className="code-txt">{ln || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const segments = text.split(/```/);

  segments.forEach((seg, si) => {
    const isCode = si % 2 === 1;
    if (isCode) {
      const nl = seg.indexOf('\n');
      const firstLine = nl === -1 ? '' : seg.slice(0, nl).trim();
      const body = nl === -1 ? seg : seg.slice(nl + 1);
      blocks.push(<CodeBlock key={`c-${si}`} code={body} lang={firstLine} />);
      return;
    }

    // Prose: split into paragraphs / lists by line.
    const lines = seg.split('\n');
    let para: string[] = [];
    let list: string[] = [];

    const flushPara = (k: string) => {
      if (!para.length) return;
      blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>);
      para = [];
    };
    const flushList = (k: string) => {
      if (!list.length) return;
      blocks.push(
        <ul key={k}>
          {list.map((li, i) => (
            <li key={i}>{inline(li, `${k}-${i}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    };

    lines.forEach((raw, li) => {
      const line = raw.trimEnd();
      const k = `${si}-${li}`;
      if (/^\s*[-*]\s+/.test(line)) {
        flushPara(`p-${k}`);
        list.push(line.replace(/^\s*[-*]\s+/, ''));
      } else if (/^\s*>\s?/.test(line)) {
        flushPara(`p-${k}`);
        flushList(`l-${k}`);
        blocks.push(<blockquote key={`q-${k}`}>{inline(line.replace(/^\s*>\s?/, ''), `q-${k}`)}</blockquote>);
      } else if (line.trim() === '') {
        flushPara(`p-${k}`);
        flushList(`l-${k}`);
      } else {
        flushList(`l-${k}`);
        para.push(line);
      }
    });
    flushPara(`p-end-${si}`);
    flushList(`l-end-${si}`);
  });

  return <div className="md">{blocks}</div>;
}
