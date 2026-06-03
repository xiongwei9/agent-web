import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  content: string;
}

// react-markdown emits raw HTML elements, so we attach Tailwind utilities per
// element rather than relying on a global stylesheet. The wrapper trims the
// outer margins of the first/last block via arbitrary child variants.
export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node: _node, ...props }) => <p className="my-0 mb-3" {...props} />,
          a: ({ node: _node, ...props }) => (
            <a className="text-accent" {...props} target="_blank" rel="noreferrer noopener" />
          ),
          pre: ({ node: _node, ...props }) => (
            <pre
              className="overflow-x-auto rounded-[10px] border border-border bg-elevated px-3.5 py-3 text-[13px] [&>code]:bg-transparent [&>code]:p-0"
              {...props}
            />
          ),
          code: ({ node: _node, ...props }) => (
            <code
              className="rounded-[5px] bg-input px-1.25 py-px font-mono text-[0.9em]"
              {...props}
            />
          ),
          table: ({ node: _node, ...props }) => (
            <table className="mb-3 w-full border-collapse" {...props} />
          ),
          th: ({ node: _node, ...props }) => (
            <th className="border border-border px-2.5 py-1.5 text-left" {...props} />
          ),
          td: ({ node: _node, ...props }) => (
            <td className="border border-border px-2.5 py-1.5 text-left" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
