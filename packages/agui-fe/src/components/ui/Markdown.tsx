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
          h1: ({ node: _node, ...props }) => (
            <h1 className="mb-3 mt-6 text-xl font-semibold" {...props} />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 className="mb-2.5 mt-5 text-lg font-semibold" {...props} />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 className="mb-2 mt-4 text-base font-semibold" {...props} />
          ),
          h4: ({ node: _node, ...props }) => (
            <h4 className="mb-2 mt-4 text-[15px] font-semibold" {...props} />
          ),
          // Tailwind's preflight strips list markers; put them back.
          ul: ({ node: _node, ...props }) => (
            <ul className="mb-3 list-disc pl-6 marker:text-muted" {...props} />
          ),
          ol: ({ node: _node, ...props }) => (
            <ol className="mb-3 list-decimal pl-6 marker:text-muted" {...props} />
          ),
          li: ({ node: _node, ...props }) => (
            <li className="my-1 [&>p]:mb-1 [&>ol]:mb-0 [&>ul]:mb-0" {...props} />
          ),
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              className="mx-0 mb-3 border-l-[3px] border-border pl-3.5 text-muted"
              {...props}
            />
          ),
          hr: ({ node: _node, ...props }) => <hr className="my-5 border-border" {...props} />,
          a: ({ node: _node, ...props }) => (
            <a
              className="text-accent underline-offset-2 hover:underline"
              {...props}
              target="_blank"
              rel="noreferrer noopener"
            />
          ),
          pre: ({ node: _node, ...props }) => (
            <pre
              className="mb-3 overflow-x-auto rounded-[10px] border border-border bg-elevated px-3.5 py-3 text-[13px] leading-normal [&>code]:bg-transparent [&>code]:p-0"
              {...props}
            />
          ),
          code: ({ node: _node, ...props }) => (
            <code
              className="rounded-[5px] bg-elevated px-1.25 py-px font-mono text-[0.88em]"
              {...props}
            />
          ),
          // Wide tables scroll inside the reply instead of stretching it.
          table: ({ node: _node, ...props }) => (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          th: ({ node: _node, ...props }) => (
            <th
              className="border border-border bg-elevated px-2.5 py-1.5 text-left font-semibold"
              {...props}
            />
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
