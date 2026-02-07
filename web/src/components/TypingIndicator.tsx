export default function TypingIndicator() {
  return (
    <div className="self-start flex gap-1 px-4 py-3 bg-gray-100 rounded-xl rounded-bl-sm">
      <span className="w-2 h-2 bg-gray-400 rounded-full animate-[bounce-dot_1.4s_ease-in-out_infinite_-0.32s]" />
      <span className="w-2 h-2 bg-gray-400 rounded-full animate-[bounce-dot_1.4s_ease-in-out_infinite_-0.16s]" />
      <span className="w-2 h-2 bg-gray-400 rounded-full animate-[bounce-dot_1.4s_ease-in-out_infinite]" />
    </div>
  );
}
