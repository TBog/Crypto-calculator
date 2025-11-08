/**
 * Lightweight Markdown to HTML Parser
 * Supports: headers, bold, italic, bullet points, numbered lists, inline code, code blocks, links
 * Designed for safe rendering of AI-generated summaries
 */

/**
 * Convert markdown text to HTML
 * @param {string} markdown - The markdown text to convert
 * @returns {string} HTML string with Tailwind CSS classes
 */
function parseMarkdown(markdown) {
    if (!markdown) return '';
    
    let html = markdown;
    
    // Escape HTML to prevent XSS
    html = html.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;');
    
    // Code blocks (``` or ~~~) - must be processed before inline code
    html = html.replace(/```([^`]*?)```/g, '<pre class="bg-gray-100 dark:bg-gray-700 rounded p-3 my-2 overflow-x-auto"><code>$1</code></pre>');
    html = html.replace(/~~~([^~]*?)~~~/g, '<pre class="bg-gray-100 dark:bg-gray-700 rounded p-3 my-2 overflow-x-auto"><code>$1</code></pre>');
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-sm font-mono">$1</code>');
    
    // Headers (must be at start of line)
    html = html.replace(/^### (.*?)$/gm, '<h3 class="text-lg font-bold mt-4 mb-2 text-gray-800 dark:text-white">$1</h3>');
    html = html.replace(/^## (.*?)$/gm, '<h2 class="text-xl font-bold mt-4 mb-2 text-gray-800 dark:text-white">$1</h2>');
    html = html.replace(/^# (.*?)$/gm, '<h1 class="text-2xl font-bold mt-4 mb-2 text-gray-800 dark:text-white">$1</h1>');
    
    // Bold (** or __)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-bold text-gray-900 dark:text-white">$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong class="font-bold text-gray-900 dark:text-white">$1</strong>');
    
    // Italic (* or _)
    html = html.replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>');
    html = html.replace(/_([^_]+)_/g, '<em class="italic">$1</em>');
    
    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener">$1</a>');
    
    // Process lists and structure - split into blocks first
    const blocks = [];
    const lines = html.split('\n');
    let currentBlock = { type: 'text', lines: [] };
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        // Detect block type
        let lineType = 'text';
        if (/^[-*+]\s+(.+)/.test(trimmedLine)) {
            lineType = 'ul';
        } else if (/^\d+\.\s+(.+)/.test(trimmedLine)) {
            lineType = 'ol';
        } else if (trimmedLine === '') {
            lineType = 'empty';
        } else if (/<h[123]/.test(trimmedLine)) {
            lineType = 'header';
        }
        
        // Check if we need to start a new block
        if (lineType !== currentBlock.type && currentBlock.lines.length > 0) {
            blocks.push(currentBlock);
            currentBlock = { type: lineType, lines: [] };
        } else if (lineType !== 'empty') {
            currentBlock.type = lineType;
        }
        
        // Add line to current block (skip empty lines between different types)
        if (lineType !== 'empty' || currentBlock.type === 'text') {
            currentBlock.lines.push(line);
        }
    }
    
    // Push the last block
    if (currentBlock.lines.length > 0) {
        blocks.push(currentBlock);
    }
    
    // Convert blocks to HTML
    const htmlBlocks = blocks.map(block => {
        if (block.type === 'ul') {
            const items = block.lines
                .map(line => line.trim())
                .filter(line => line)
                .map(line => {
                    const match = line.match(/^[-*+]\s+(.+)/);
                    return match ? `<li class="ml-4">${match[1]}</li>` : '';
                })
                .join('');
            return `<ul class="list-disc list-inside my-3 space-y-1">${items}</ul>`;
        } else if (block.type === 'ol') {
            const items = block.lines
                .map(line => line.trim())
                .filter(line => line)
                .map(line => {
                    const match = line.match(/^\d+\.\s+(.+)/);
                    return match ? `<li class="ml-4">${match[1]}</li>` : '';
                })
                .join('');
            return `<ol class="list-decimal list-inside my-3 space-y-1">${items}</ol>`;
        } else if (block.type === 'header') {
            return block.lines.filter(line => line.trim()).join('<br>');
        } else {
            // Regular text block - filter out empty lines before joining
            const text = block.lines
                .filter(line => line.trim())
                .join('<br>');
            return text ? `<p class="my-2">${text}</p>` : '';
        }
    }).filter(b => b);
    
    html = htmlBlocks.join('');
    
    return html;
}
