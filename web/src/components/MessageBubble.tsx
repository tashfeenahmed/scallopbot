import { useMemo } from 'react';
import { marked } from 'marked';
import type { ChatMessage } from '../App';

marked.setOptions({ breaks: true, gfm: true });

interface MessageBubbleProps {
  message: ChatMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const html = useMemo(() => {
    if (message.isMarkdown && message.content) {
      try {
        return marked.parse(message.content) as string;
      } catch {
        return message.content;
      }
    }
    return null;
  }, [message.content, message.isMarkdown]);

  switch (message.type) {
    case 'user':
      return (
        <div className="self-end max-w-[65%] max-md:max-w-[85%] px-3 py-2 rounded-xl rounded-br-sm bg-blue-50 text-gray-900 animate-[fade-in_0.15s_ease-out] whitespace-pre-wrap">
          {message.content}
        </div>
      );

    case 'assistant':
      return (
        <div className="self-start max-w-[65%] max-md:max-w-[85%] px-3 py-2 rounded-xl rounded-bl-sm bg-gray-100 text-gray-900 animate-[fade-in_0.15s_ease-out]">
          {html ? (
            <div
              className="markdown-content leading-relaxed"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <span className="whitespace-pre-wrap">{message.content}</span>
          )}
        </div>
      );

    case 'system':
      return (
        <div className="self-center px-3 py-1 text-xs text-gray-500 bg-gray-100 rounded-full animate-[fade-in_0.15s_ease-out]">
          {message.content}
        </div>
      );

    case 'error':
      return (
        <div className="self-center px-3 py-1.5 text-xs text-red-600 bg-red-50 rounded-lg animate-[fade-in_0.15s_ease-out]">
          {message.content}
        </div>
      );

    default:
      return null;
  }
}
