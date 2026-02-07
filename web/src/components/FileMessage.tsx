interface FileMessageProps {
  filePath?: string;
  caption?: string;
}

export default function FileMessage({ filePath, caption }: FileMessageProps) {
  if (!filePath) return null;
  const fileName = filePath.split('/').pop() || 'file';

  return (
    <div className="self-start max-w-[65%] max-md:max-w-[85%] animate-[fade-in_0.15s_ease-out]">
      <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-lg">
        <span className="text-lg">📄</span>
        <span className="flex-1 font-medium text-gray-900 text-sm break-all">{fileName}</span>
        <a
          href={'/api/files?path=' + encodeURIComponent(filePath)}
          download={fileName}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1 bg-blue-500 text-white text-xs font-medium rounded hover:bg-blue-600 transition-colors whitespace-nowrap"
        >
          Download
        </a>
      </div>
      {caption && <div className="mt-1 text-sm text-gray-500">{caption}</div>}
    </div>
  );
}
