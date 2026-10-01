interface FileMessageProps {
  filePath?: string;
  caption?: string;
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;

export default function FileMessage({ filePath, caption }: FileMessageProps) {
  if (!filePath) return null;
  const fileName = filePath.split('/').pop() || 'file';
  const href = '/api/files?path=' + encodeURIComponent(filePath);

  if (IMAGE_EXT.test(fileName)) {
    return (
      <div className="self-start max-w-[65%] max-md:max-w-[85%] animate-[fade-in_0.15s_ease-out]">
        <a href={href} target="_blank" rel="noopener noreferrer" title={`Open ${fileName}`}>
          <img
            src={href}
            alt={caption || fileName}
            loading="lazy"
            className="block max-h-96 w-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"
          />
        </a>
        {caption && <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{caption}</div>}
      </div>
    );
  }

  return (
    <div className="self-start max-w-[65%] max-md:max-w-[85%] animate-[fade-in_0.15s_ease-out]">
      <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-50 dark:bg-gray-800 border border-blue-100 dark:border-gray-700 rounded-lg">
        <span className="text-lg">📄</span>
        <span className="flex-1 font-medium text-gray-900 dark:text-gray-100 text-sm break-all">{fileName}</span>
        <a
          href={href}
          download={fileName}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1 bg-blue-500 text-white text-xs font-medium rounded hover:bg-blue-600 transition-colors whitespace-nowrap"
        >
          Download
        </a>
      </div>
      {caption && <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{caption}</div>}
    </div>
  );
}
