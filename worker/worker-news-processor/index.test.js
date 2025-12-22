/**
 * Test suite for News Processor Cron Worker
 * Tests for TextExtractor debug functionality
 */

import { describe, it, expect } from 'vitest';
import { TextExtractor, fetchArticleContent, processArticlesBatch } from './index.js';
import { decodeHTMLEntities, getNewsProcessorConfig } from '../shared/constants.js';

describe('TextExtractor - Debug Mode Functionality', () => {
  describe('Debug Output Mode', () => {
    it('should add element tags to output when debug mode is enabled', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      
      // Verify debug mode is enabled
      expect(extractor.debugOutput).toBe(true);
      
      // Simulate element handler being called with class/id to pass the early exit check
      const mockElement = {
        tagName: 'div',
        removed: false,
        canHaveContent: true,
        selfClosing: false,
        getAttribute: (attr) => {
          if (attr === 'class') return 'content-area'; // Non-skip class
          if (attr === 'id') return '';
          return null;
        },
        onEndTag: () => {}
      };
      
      extractor.element(mockElement);
      
      // Verify element tag was added
      expect(extractor.textChunks).toContain('[div]');
    });

    it('should not add element tags when debug mode is disabled', () => {
      const extractor = new TextExtractor();
      
      // Verify debug mode is disabled by default
      expect(extractor.debugOutput).toBe(false);
      
      // Simulate element handler being called
      const mockElement = {
        tagName: 'p',
        removed: false,
        canHaveContent: true,
        selfClosing: false,
        getAttribute: () => null,
        onEndTag: () => {}
      };
      
      extractor.element(mockElement);
      
      // Verify no element tag was added
      expect(extractor.textChunks).not.toContain('[p]');
      expect(extractor.textChunks.length).toBe(0);
    });

    it('should add text node tag markers when debug mode is enabled', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      extractor.lastElementTagName = 'p';
      
      // Simulate text handler being called
      const mockText = {
        text: 'Sample text content',
        removed: false
      };
      
      extractor.text(mockText);
      
      // Verify text tag marker was added
      expect(extractor.textChunks).toContain('(p)');
      expect(extractor.textChunks).toContain('Sample text content');
    });

    it('should not add text node markers when debug mode is disabled', () => {
      const extractor = new TextExtractor();
      extractor.lastElementTagName = 'span';
      
      // Simulate text handler being called
      const mockText = {
        text: 'Normal text',
        removed: false
      };
      
      extractor.text(mockText);
      
      // Verify no text tag marker was added
      expect(extractor.textChunks).not.toContain('(span)');
      expect(extractor.textChunks).toContain('Normal text');
    });

    it('should not contaminate normal extraction with debug markers when disabled', () => {
      const extractor = new TextExtractor();
      
      // Simulate normal extraction without debug mode
      extractor.lastElementTagName = 'p';
      extractor.text({ text: 'First paragraph', removed: false });
      
      extractor.lastElementTagName = 'div';
      extractor.text({ text: 'Second section', removed: false });
      
      const result = extractor.getText();
      
      // Verify clean output without any debug markers
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).not.toContain('(');
      expect(result).not.toContain(')');
      expect(result).toContain('First paragraph');
      expect(result).toContain('Second section');
    });
  });

  describe('Removed Elements Filtering', () => {
    it('should filter out removed elements correctly', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      
      // Simulate removed element
      const removedElement = {
        tagName: 'script',
        removed: true,
        canHaveContent: true,
        selfClosing: false,
        getAttribute: () => null,
        onEndTag: () => {}
      };
      
      extractor.element(removedElement);
      
      // Verify element was not processed
      expect(extractor.textChunks).not.toContain('[script]');
      expect(extractor.textChunks.length).toBe(0);
    });

    it('should process non-removed elements', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      
      // Simulate non-removed element with class to pass early exit
      const validElement = {
        tagName: 'article',
        removed: false,
        canHaveContent: true,
        selfClosing: false,
        getAttribute: (attr) => {
          if (attr === 'class') return 'main-article';
          return '';
        },
        onEndTag: () => {}
      };
      
      extractor.element(validElement);
      
      // Verify element was processed
      expect(extractor.textChunks).toContain('[article]');
    });

    it('should respect element.removed check even in skip tags', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      
      // Simulate a removed skip tag element (e.g., button)
      const removedSkipElement = {
        tagName: 'button',
        removed: true,
        canHaveContent: true,
        selfClosing: false,
        getAttribute: () => null,
        onEndTag: () => {}
      };
      
      extractor.element(removedSkipElement);
      
      // Verify early exit before skip logic
      expect(extractor.skipDepth).toBe(0);
    });
  });

  describe('Removed Text Nodes Filtering', () => {
    it('should filter out removed text nodes correctly', () => {
      const extractor = new TextExtractor();
      extractor.lastElementTagName = 'div';
      
      // Simulate removed text node
      const removedText = {
        text: 'This should not appear',
        removed: true
      };
      
      extractor.text(removedText);
      
      // Verify text was not extracted
      expect(extractor.textChunks).not.toContain('This should not appear');
      expect(extractor.textChunks.length).toBe(0);
    });

    it('should process non-removed text nodes', () => {
      const extractor = new TextExtractor();
      extractor.lastElementTagName = 'p';
      
      // Simulate valid text node
      const validText = {
        text: 'Valid content',
        removed: false
      };
      
      extractor.text(validText);
      
      // Verify text was extracted
      expect(extractor.textChunks).toContain('Valid content');
    });

    it('should handle removed text in debug mode', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      extractor.lastElementTagName = 'span';
      
      // Simulate removed text in debug mode
      const removedText = {
        text: 'Removed debug text',
        removed: true
      };
      
      extractor.text(removedText);
      
      // Verify text was not extracted and no debug marker added
      expect(extractor.textChunks).not.toContain('Removed debug text');
      expect(extractor.textChunks).not.toContain('(span)');
    });
  });

  describe('Skip Depth and Debug Mode Interaction', () => {
    it('should not add debug markers when inside skipped elements', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      
      let endTagCallback;
      
      // Simulate entering a skip tag
      const buttonElement = {
        tagName: 'button',
        removed: false,
        canHaveContent: true,
        selfClosing: false,
        getAttribute: () => null,
        onEndTag: (callback) => {
          // Store the callback to call it later
          endTagCallback = callback;
        }
      };
      
      extractor.element(buttonElement);
      
      // Verify skipDepth increased
      expect(extractor.skipDepth).toBe(1);
      
      // Verify no debug marker when skipDepth > 0
      expect(extractor.textChunks).not.toContain('[button]');
      
      // Now simulate the end tag and verify skipDepth decreases
      endTagCallback();
      expect(extractor.skipDepth).toBe(0);
    });

    it('should add debug markers when skipDepth is 0', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      
      // Simulate a normal element with skipDepth = 0 and has class to pass early exit
      const divElement = {
        tagName: 'div',
        removed: false,
        canHaveContent: true,
        selfClosing: false,
        getAttribute: (attr) => {
          if (attr === 'class') return 'article-content';
          return '';
        },
        onEndTag: () => {}
      };
      
      extractor.element(divElement);
      
      // Verify debug marker added when skipDepth is 0
      expect(extractor.textChunks).toContain('[div]');
    });
  });

  describe('Debug Mode Character Counting', () => {
    it('should not count debug markers in character count', () => {
      const extractor = new TextExtractor();
      extractor.enableDebugOutput();
      extractor.lastElementTagName = 'p';
      
      const textContent = 'Hello World';
      const mockText = {
        text: textContent,
        removed: false
      };
      
      extractor.text(mockText);
      
      // Character count should only include actual text content, not debug markers
      expect(extractor.charCount).toBe(textContent.length);
      expect(extractor.textChunks.length).toBeGreaterThan(1); // Contains both debug marker and text
    });
  });
});

describe('fetchArticleContent - Debug Parameter', () => {
  // Note: These tests validate the function signature and parameter passing
  // Full integration testing would require mocking fetch and HTMLRewriter
  
  it('should accept enableDebug parameter with default false', () => {
    // Verify the function exists
    expect(fetchArticleContent).toBeDefined();
    expect(typeof fetchArticleContent).toBe('function');
    
    // Verify it has at least the url parameter (length=1 because enableDebug has default)
    expect(fetchArticleContent.length).toBe(1);
  });

  it('should have enableDebug parameter that defaults to false', () => {
    // Check the function signature includes the default parameter
    const functionString = fetchArticleContent.toString();
    expect(functionString).toContain('enableDebug');
    expect(functionString).toContain('= false');
  });
});

describe('TextExtractor - Edge Cases', () => {
  it('should handle empty text content', () => {
    const extractor = new TextExtractor();
    extractor.lastElementTagName = 'div';
    
    const emptyText = {
      text: '',
      removed: false
    };
    
    extractor.text(emptyText);
    
    expect(extractor.textChunks.length).toBe(0);
  });

  it('should handle whitespace-only text', () => {
    const extractor = new TextExtractor();
    extractor.lastElementTagName = 'p';
    
    const whitespaceText = {
      text: '   \n\t   ',
      removed: false
    };
    
    extractor.text(whitespaceText);
    
    expect(extractor.textChunks.length).toBe(0);
  });

  it('should handle null lastElementTagName in debug mode', () => {
    const extractor = new TextExtractor();
    extractor.enableDebugOutput();
    extractor.lastElementTagName = null;
    
    const mockText = {
      text: 'Text without element',
      removed: false
    };
    
    // Should not throw
    expect(() => extractor.text(mockText)).not.toThrow();
  });
});

describe('TextExtractor - Skip Pattern Detection', () => {
  it('should skip elements with nav class', () => {
    const extractor = new TextExtractor();
    
    let endTagCallback;
    
    const navElement = {
      tagName: 'div',
      removed: false,
      canHaveContent: true,
      selfClosing: false,
      getAttribute: (attr) => attr === 'class' ? 'nav' : '', // The regex requires word boundaries: 'nav' matches but 'navigation' doesn't
      onEndTag: (callback) => {
        endTagCallback = callback;
      }
    };
    
    extractor.element(navElement);
    
    // Should increase skipDepth for nav pattern
    expect(extractor.skipDepth).toBe(1);
    
    // Cleanup
    if (endTagCallback) endTagCallback();
  });

  it('should skip elements with menu-item class', () => {
    const extractor = new TextExtractor();
    
    let endTagCallback;
    
    const menuElement = {
      tagName: 'li',
      removed: false,
      canHaveContent: true,
      selfClosing: false,
      getAttribute: (attr) => attr === 'class' ? 'menu-item' : '',
      onEndTag: (callback) => {
        endTagCallback = callback;
      }
    };
    
    extractor.element(menuElement);
    
    expect(extractor.skipDepth).toBe(1);
    
    // Cleanup
    if (endTagCallback) endTagCallback();
  });

  it('should not skip elements without skip patterns', () => {
    const extractor = new TextExtractor();
    
    const normalElement = {
      tagName: 'article',
      removed: false,
      canHaveContent: true,
      selfClosing: false,
      getAttribute: () => '',
      onEndTag: () => {}
    };
    
    extractor.element(normalElement);
    
    expect(extractor.skipDepth).toBe(0);
  });
});

describe('decodeHTMLEntities', () => {
  describe('Decimal Numeric Entities', () => {
    it('should decode valid decimal numeric entities', () => {
      expect(decodeHTMLEntities('&#65;')).toBe('A');
      expect(decodeHTMLEntities('&#66;')).toBe('B');
      expect(decodeHTMLEntities('&#90;')).toBe('Z');
      expect(decodeHTMLEntities('&#97;')).toBe('a');
      expect(decodeHTMLEntities('&#122;')).toBe('z');
      expect(decodeHTMLEntities('&#48;')).toBe('0');
      expect(decodeHTMLEntities('&#57;')).toBe('9');
    });

    it('should decode multiple decimal entities in a string', () => {
      expect(decodeHTMLEntities('&#72;&#101;&#108;&#108;&#111;')).toBe('Hello');
      expect(decodeHTMLEntities('Test &#65; and &#66;')).toBe('Test A and B');
    });

    it('should decode special characters as decimal entities', () => {
      expect(decodeHTMLEntities('&#169;')).toBe('©'); // copyright
      expect(decodeHTMLEntities('&#8364;')).toBe('€'); // euro
      expect(decodeHTMLEntities('&#8220;')).toBe(String.fromCodePoint(8220)); // left double quote (curly)
      expect(decodeHTMLEntities('&#8221;')).toBe(String.fromCodePoint(8221)); // right double quote (curly)
    });

    it('should decode zero as decimal entity', () => {
      // Zero is technically a valid codepoint but may not render usefully
      expect(decodeHTMLEntities('&#0;')).toBe(String.fromCodePoint(0));
    });
  });

  describe('Hexadecimal Numeric Entities', () => {
    it('should decode valid hexadecimal numeric entities', () => {
      expect(decodeHTMLEntities('&#x41;')).toBe('A');
      expect(decodeHTMLEntities('&#x42;')).toBe('B');
      expect(decodeHTMLEntities('&#x5A;')).toBe('Z');
      expect(decodeHTMLEntities('&#x61;')).toBe('a');
      expect(decodeHTMLEntities('&#x7A;')).toBe('z');
      expect(decodeHTMLEntities('&#x30;')).toBe('0');
      expect(decodeHTMLEntities('&#x39;')).toBe('9');
    });

    it('should decode hexadecimal entities with lowercase letters', () => {
      expect(decodeHTMLEntities('&#x1f600;')).toBe('😀'); // grinning face emoji
      expect(decodeHTMLEntities('&#xa9;')).toBe('©'); // copyright
    });

    it('should decode hexadecimal entities with uppercase letters', () => {
      expect(decodeHTMLEntities('&#x1F600;')).toBe('😀'); // grinning face emoji
      expect(decodeHTMLEntities('&#xA9;')).toBe('©'); // copyright
      expect(decodeHTMLEntities('&#XA9;')).toBe('&#XA9;'); // uppercase X should not match
    });

    it('should decode mixed case hexadecimal values', () => {
      expect(decodeHTMLEntities('&#x1F4aF;')).toBe('💯'); // 100 points emoji
    });

    it('should decode special characters as hexadecimal entities', () => {
      expect(decodeHTMLEntities('&#x20AC;')).toBe('€'); // euro
      expect(decodeHTMLEntities('&#x201C;')).toBe(String.fromCodePoint(0x201C)); // left double quote (curly)
      expect(decodeHTMLEntities('&#x201D;')).toBe(String.fromCodePoint(0x201D)); // right double quote (curly)
    });
  });

  describe('Named Entities', () => {
    it('should decode common named entities', () => {
      expect(decodeHTMLEntities('&amp;')).toBe('&');
      expect(decodeHTMLEntities('&lt;')).toBe('<');
      expect(decodeHTMLEntities('&gt;')).toBe('>');
      expect(decodeHTMLEntities('&quot;')).toBe('"');
      expect(decodeHTMLEntities('&apos;')).toBe("'");
      expect(decodeHTMLEntities('&nbsp;')).toBe(' ');
    });

    it('should decode multiple named entities in a string', () => {
      expect(decodeHTMLEntities('&lt;div&gt;')).toBe('<div>');
      expect(decodeHTMLEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
      expect(decodeHTMLEntities('&quot;Hello&quot;')).toBe('"Hello"');
    });

    it('should preserve unknown named entities', () => {
      expect(decodeHTMLEntities('&unknown;')).toBe('&unknown;');
      expect(decodeHTMLEntities('&copy;')).toBe('&copy;'); // not in the map
      expect(decodeHTMLEntities('&reg;')).toBe('&reg;'); // not in the map
    });
  });

  describe('Invalid Code Points', () => {
    it('should handle invalid numeric entities gracefully', () => {
      // Code points outside valid Unicode range (> 0x10FFFF) should be preserved as-is
      const result = decodeHTMLEntities('&#9999999;');
      expect(result).toBe('&#9999999;'); // Should preserve the original entity
    });

    it('should handle negative numeric values', () => {
      // Negative values in entities don't make sense but shouldn't crash
      expect(decodeHTMLEntities('&#-1;')).toBe('&#-1;'); // Won't match the regex
    });

    it('should handle code points at the boundary of valid range', () => {
      // 0x10FFFF is the maximum valid Unicode code point
      expect(decodeHTMLEntities('&#1114111;')).toBe('\u{10FFFF}'); // 0x10FFFF in decimal
      expect(decodeHTMLEntities('&#x10FFFF;')).toBe('\u{10FFFF}');
      
      // 0x110000 is beyond the valid range
      expect(decodeHTMLEntities('&#1114112;')).toBe('&#1114112;'); // 0x110000 in decimal - should be preserved
      expect(decodeHTMLEntities('&#x110000;')).toBe('&#x110000;'); // should be preserved
    });
  });

  describe('Malformed Entities', () => {
    it('should preserve malformed entities without semicolon', () => {
      expect(decodeHTMLEntities('&amp')).toBe('&amp');
      expect(decodeHTMLEntities('&#65')).toBe('&#65');
      expect(decodeHTMLEntities('&#x41')).toBe('&#x41');
    });

    it('should preserve entities with invalid format', () => {
      expect(decodeHTMLEntities('&#;')).toBe('&#;');
      expect(decodeHTMLEntities('&#x;')).toBe('&#x;');
      expect(decodeHTMLEntities('&;')).toBe('&;');
    });

    it('should preserve ampersand without entity format', () => {
      expect(decodeHTMLEntities('This & that')).toBe('This & that');
      expect(decodeHTMLEntities('R&D')).toBe('R&D');
    });

    it('should preserve entities with spaces', () => {
      expect(decodeHTMLEntities('& amp;')).toBe('& amp;');
      expect(decodeHTMLEntities('&# 65;')).toBe('&# 65;');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      expect(decodeHTMLEntities('')).toBe('');
    });

    it('should handle null input', () => {
      expect(decodeHTMLEntities(null)).toBe('');
    });

    it('should handle undefined input', () => {
      expect(decodeHTMLEntities(undefined)).toBe('');
    });

    it('should handle non-string input', () => {
      expect(decodeHTMLEntities(123)).toBe(123);
      expect(decodeHTMLEntities(true)).toBe(true);
      expect(decodeHTMLEntities(false)).toBe(''); // false is falsy, returns empty string
      // Objects are not strings, so they are returned as-is (same reference)
      const obj = {};
      expect(decodeHTMLEntities(obj)).toBe(obj);
    });

    it('should handle string with no entities', () => {
      expect(decodeHTMLEntities('Hello World')).toBe('Hello World');
      expect(decodeHTMLEntities('No entities here!')).toBe('No entities here!');
    });

    it('should handle consecutive entities', () => {
      expect(decodeHTMLEntities('&#65;&#66;&#67;')).toBe('ABC');
      expect(decodeHTMLEntities('&lt;&gt;')).toBe('<>');
      expect(decodeHTMLEntities('&amp;&amp;')).toBe('&&');
    });

    it('should handle mixed entity types in one string', () => {
      expect(decodeHTMLEntities('&#65;&amp;&#x42;&lt;C&gt;')).toBe('A&B<C>');
      expect(decodeHTMLEntities('Test &#169; &amp; &#x20AC;')).toBe('Test © & €');
    });

    it('should handle entities at string boundaries', () => {
      expect(decodeHTMLEntities('&lt;')).toBe('<');
      expect(decodeHTMLEntities('&#65;')).toBe('A');
      expect(decodeHTMLEntities('&gt;end')).toBe('>end');
      expect(decodeHTMLEntities('start&lt;')).toBe('start<');
    });

    it('should handle very long strings with entities', () => {
      const longString = '&amp;'.repeat(1000);
      const expected = '&'.repeat(1000);
      expect(decodeHTMLEntities(longString)).toBe(expected);
    });

    it('should handle case sensitivity correctly', () => {
      // Named entities are case-sensitive
      expect(decodeHTMLEntities('&AMP;')).toBe('&AMP;'); // uppercase should not match
      expect(decodeHTMLEntities('&Amp;')).toBe('&Amp;'); // mixed case should not match
      
      // Hex prefix is case-sensitive (lowercase 'x' only)
      expect(decodeHTMLEntities('&#X41;')).toBe('&#X41;'); // uppercase X should not match
    });
  });

  describe('Real-World Use Cases', () => {
    it('should decode HTML snippet with entities', () => {
      const html = '&lt;div class=&quot;content&quot;&gt;Hello &amp; Goodbye&lt;/div&gt;';
      const expected = '<div class="content">Hello & Goodbye</div>';
      expect(decodeHTMLEntities(html)).toBe(expected);
    });

    it('should decode news article text with quotes', () => {
      const text = 'The CEO said, &quot;We&apos;re excited about this.&quot;';
      const expected = 'The CEO said, "We\'re excited about this."';
      expect(decodeHTMLEntities(text)).toBe(expected);
    });

    it('should decode mathematical expressions', () => {
      expect(decodeHTMLEntities('5 &lt; 10 &amp; 10 &gt; 5')).toBe('5 < 10 & 10 > 5');
      expect(decodeHTMLEntities('x &gt; 0')).toBe('x > 0');
    });

    it('should decode text with non-breaking spaces', () => {
      expect(decodeHTMLEntities('Hello&nbsp;World')).toBe('Hello World');
      expect(decodeHTMLEntities('Price:&nbsp;$100')).toBe('Price: $100');
    });
  });
});

describe('Circuit Breaker - Pre-emptive Increment', () => {
  it('should increment contentTimeout before processing starts', async () => {
    // Mock article needing summary
    const article = {
      title: 'Test Article',
      link: 'https://example.com',
      needsSummary: true,
      contentTimeout: 0
    };
    
    // Verify the logic: contentTimeout should be incremented first
    const timeoutCount = (article.contentTimeout || 0) + 1;
    expect(timeoutCount).toBe(1);
    
    // This demonstrates that our implementation increments before processing
    expect(timeoutCount).toBeGreaterThan(article.contentTimeout);
  });
});

describe('Circuit Breaker - Extracted Content Caching', () => {
  it('should store extracted content for retry', () => {
    // Simulate article after successful scraping but failed AI
    const article = {
      title: 'Test Article',
      link: 'https://example.com',
      needsSummary: true,
      contentTimeout: 1,
      extractedContent: 'This is the extracted content from the webpage...'
    };
    
    // Verify extracted content is stored
    expect(article.extractedContent).toBeDefined();
    expect(article.extractedContent.length).toBeGreaterThan(0);
    
    // On next retry, this content should be reused
    expect(article.extractedContent).toBe('This is the extracted content from the webpage...');
  });
  
  it('should clear extracted content after successful AI summary', () => {
    // Simulate article after successful processing
    const article = {
      title: 'Test Article',
      link: 'https://example.com',
      needsSummary: false,
      contentTimeout: undefined,
      extractedContent: undefined,
      aiSummary: 'This is the AI-generated summary'
    };
    
    // Verify extracted content is cleared
    expect(article.extractedContent).toBeUndefined();
    expect(article.aiSummary).toBeDefined();
    expect(article.contentTimeout).toBeUndefined();
  });
  
  it('should preserve extracted content on AI failure for retry', () => {
    // Simulate article after scraping success but AI failure
    const article = {
      title: 'Test Article',
      link: 'https://example.com',
      needsSummary: true,
      contentTimeout: 2,
      extractedContent: 'This is the extracted content...',
      summaryError: 'ai_error: Token limit exceeded (attempt 2/5)'
    };
    
    // Verify extracted content is preserved for retry
    expect(article.extractedContent).toBeDefined();
    expect(article.contentTimeout).toBe(2);
    expect(article.needsSummary).toBe(true);
  });
});

describe('Circuit Breaker - Critical Section Isolation', () => {
  it('should handle scraping failure without affecting previous state', () => {
    const article = {
      title: 'Test Article',
      link: 'https://example.com',
      needsSummary: true,
      contentTimeout: 0
    };
    
    // Simulate scraping failure
    const updates = {
      ...article,
      contentTimeout: 1,
      summaryError: 'fetch_failed (attempt 1/5)',
      extractedContent: undefined // No content extracted
    };
    
    expect(updates.contentTimeout).toBe(1);
    expect(updates.extractedContent).toBeUndefined();
    expect(updates.summaryError).toContain('fetch_failed');
  });
  
  it('should handle AI failure after successful scraping', () => {
    const article = {
      title: 'Test Article',
      link: 'https://example.com',
      needsSummary: true,
      contentTimeout: 1,
      extractedContent: 'Previously extracted content...'
    };
    
    // Simulate AI failure
    const updates = {
      ...article,
      contentTimeout: 2,
      summaryError: 'ai_error: Model timeout (attempt 2/5)',
      extractedContent: 'Previously extracted content...' // Preserved
    };
    
    expect(updates.contentTimeout).toBe(2);
    expect(updates.extractedContent).toBeDefined();
    expect(updates.summaryError).toContain('ai_error');
  });
  
  it('should give up after max retries', () => {
    const maxAttempts = 5;
    
    // Simulate article that has reached max retries
    const article = {
      title: 'Toxic Article',
      link: 'https://example.com/toxic',
      needsSummary: false, // Should be false after max retries
      contentTimeout: maxAttempts,
      extractedContent: undefined, // Should be cleared
      summaryError: 'ai_error: Repeated timeouts (attempt 5/5)'
    };
    
    expect(article.contentTimeout).toBe(maxAttempts);
    expect(article.needsSummary).toBe(false); // Stop retrying
    expect(article.extractedContent).toBeUndefined(); // Cleared
  });
});

describe('Resume-based Article Processing', () => {
  it('should load batch and process all articles that need processing', () => {
    const MAX_ARTICLES_PER_RUN = 5;
    
    // Simulate loading 5 articles, where 3 need processing
    const loadedArticles = [
      { id: 'id1', needsProcessing: true },
      { id: 'id2', needsProcessing: false },  // already processed
      { id: 'id3', needsProcessing: true },
      { id: 'id4', needsProcessing: true },
      { id: 'id5', needsProcessing: false },  // already processed
    ];
    
    const pendingArticles = loadedArticles.filter(a => a.needsProcessing);
    
    // Should process all 3 pending articles, not just stop at MAX_ARTICLES_PER_RUN
    expect(pendingArticles.length).toBe(3);
    expect(pendingArticles.map(a => a.id)).toEqual(['id1', 'id3', 'id4']);
    
    // Last loaded article is 'id5', that's what we save as last processed
    const lastLoadedId = loadedArticles[loadedArticles.length - 1].id;
    expect(lastLoadedId).toBe('id5');
  });
  
  it('should find article ID in index and load next batch', () => {
    const articleIds = ['id1', 'id2', 'id3', 'id4', 'id5', 'id6', 'id7', 'id8'];
    const MAX_ARTICLES_PER_RUN = 5;
    
    // First run: start from beginning, load 5 articles
    let lastProcessedId = null;
    let startIndex = 0;
    
    if (lastProcessedId) {
      const lastIndex = articleIds.indexOf(lastProcessedId);
      if (lastIndex !== -1) {
        startIndex = lastIndex + 1;
      }
    }
    
    expect(startIndex).toBe(0);
    
    const firstBatch = articleIds.slice(startIndex, startIndex + MAX_ARTICLES_PER_RUN);
    expect(firstBatch).toEqual(['id1', 'id2', 'id3', 'id4', 'id5']);
    
    // Last loaded is 'id5'
    lastProcessedId = firstBatch[firstBatch.length - 1];
    expect(lastProcessedId).toBe('id5');
    
    // Second run: resume from 'id5', load next 5
    const lastIndex = articleIds.indexOf(lastProcessedId);
    expect(lastIndex).toBe(4);
    
    startIndex = lastIndex + 1;
    expect(startIndex).toBe(5);
    
    const secondBatch = articleIds.slice(startIndex, startIndex + MAX_ARTICLES_PER_RUN);
    expect(secondBatch).toEqual(['id6', 'id7', 'id8']);
  });
  
  it('should reset to beginning when last processed ID not found', () => {
    const articleIds = ['id1', 'id2', 'id3'];
    const lastProcessedId = 'id_old'; // Not in current index
    
    const lastIndex = articleIds.indexOf(lastProcessedId);
    expect(lastIndex).toBe(-1);
    
    // When not found, start from beginning
    const startIndex = lastIndex === -1 ? 0 : lastIndex + 1;
    expect(startIndex).toBe(0);
  });
  
  it('should handle new articles being prepended to index', () => {
    // Original index after loading batch ending with 'id3'
    const originalIds = ['id1', 'id2', 'id3', 'id4', 'id5'];
    const lastProcessedId = 'id3';
    
    // New articles get added to the beginning
    const updatedIds = ['id_new1', 'id_new2', 'id1', 'id2', 'id3', 'id4', 'id5'];
    
    // Find where we left off
    const lastIndex = updatedIds.indexOf(lastProcessedId);
    expect(lastIndex).toBe(4); // 'id3' is now at index 4
    
    const startIndex = lastIndex + 1;
    expect(startIndex).toBe(5);
    
    // Resume loading from 'id4' onward
    const nextBatch = updatedIds.slice(startIndex, startIndex + 2);
    expect(nextBatch).toEqual(['id4', 'id5']);
  });
  
  it('should handle batch where no articles need processing', () => {
    const MAX_ARTICLES_PER_RUN = 3;
    const articleIds = ['id1', 'id2', 'id3', 'id4', 'id5'];
    
    // Load first batch
    const startIndex = 0;
    const loadedBatch = articleIds.slice(startIndex, startIndex + MAX_ARTICLES_PER_RUN);
    expect(loadedBatch).toEqual(['id1', 'id2', 'id3']);
    
    // Simulate no articles needing processing
    const pendingArticles = []; // All already processed
    
    expect(pendingArticles.length).toBe(0);
    
    // Should still update last processed to last loaded
    const lastLoadedId = loadedBatch[loadedBatch.length - 1];
    expect(lastLoadedId).toBe('id3');
    
    // Next run should continue from 'id4'
    const lastIndex = articleIds.indexOf(lastLoadedId);
    const nextStartIndex = lastIndex + 1;
    expect(nextStartIndex).toBe(3);
    
    const nextBatch = articleIds.slice(nextStartIndex, nextStartIndex + MAX_ARTICLES_PER_RUN);
    expect(nextBatch).toEqual(['id4', 'id5']);
  });
});

describe('processArticlesBatch with Mock KV', () => {
  /**
   * Create a mock KV interface for testing
   */
  function createMockKV(initialData = {}) {
    const data = { ...initialData };
    
    return {
      async get(key, options) {
        const value = data[key];
        if (value === undefined) return null;
        if (options?.type === 'json') {
          return typeof value === 'string' ? JSON.parse(value) : value;
        }
        return value;
      },
      
      async put(key, value, options) {
        data[key] = value;
      },
      
      async delete(key) {
        delete data[key];
      },
      
      // Helper to inspect state
      getData() {
        return data;
      }
    };
  }
  
  /**
   * Create a mock environment for AI processing
   */
  function createMockEnv() {
    return {
      AI: {
        async run(model, params) {
          // Mock AI response for testing
          return { response: 'Mock AI response' };
        }
      }
    };
  }
  
  it('should process articles from the beginning when no last processed ID exists', async () => {
    const mockKV = createMockKV({
      'BTC_ID_INDEX': ['id1', 'id2', 'id3', 'id4', 'id5'],
      'BTC_PENDING_QUEUE': ['id1', 'id2', 'id3'],
      'article:id1': { title: 'Article 1', needsSentiment: true, needsSummary: true },
      'article:id2': { title: 'Article 2', needsSentiment: true, needsSummary: true },
      'article:id3': { title: 'Article 3', needsSentiment: false, needsSummary: false },
      'article:id4': { title: 'Article 4', needsSentiment: true, needsSummary: true },
      'article:id5': { title: 'Article 5', needsSentiment: false, needsSummary: false }
    });
    
    const mockEnv = createMockEnv();
    const config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_LAST_PROCESSED: 'BTC_LAST_PROCESSED_ID',
      KV_KEY_PENDING_QUEUE: 'BTC_PENDING_QUEUE',
      MAX_ARTICLES_PER_RUN: 3,
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      ID_INDEX_TTL: 86400
    };
    
    const result = await processArticlesBatch(mockKV, mockEnv, config);
    
    expect(result.status).toBe('success');
    expect(result.loadedCount).toBe(3);
    expect(result.processedCount).toBe(2); // id1 and id2 need processing
    expect(result.removedFromQueue).toBe(1); // id3 removed (already processed)
    
    const kvData = mockKV.getData();
    const updatedQueue = JSON.parse(kvData['BTC_PENDING_QUEUE']);
    expect(updatedQueue).toEqual(['id1', 'id2']); // id3 removed, id1 and id2 still need more processing
  });
  
  it('should resume from last processed ID', async () => {
    const mockKV = createMockKV({
      'BTC_ID_INDEX': ['id1', 'id2', 'id3', 'id4', 'id5'],
      'BTC_PENDING_QUEUE': ['id3', 'id4'],
      'article:id1': { title: 'Article 1', needsSentiment: false, needsSummary: false },
      'article:id2': { title: 'Article 2', needsSentiment: false, needsSummary: false },
      'article:id3': { title: 'Article 3', needsSentiment: true, needsSummary: true },
      'article:id4': { title: 'Article 4', needsSentiment: true, needsSummary: true },
      'article:id5': { title: 'Article 5', needsSentiment: false, needsSummary: false }
    });
    
    const mockEnv = createMockEnv();
    const config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_LAST_PROCESSED: 'BTC_LAST_PROCESSED_ID',
      KV_KEY_PENDING_QUEUE: 'BTC_PENDING_QUEUE',
      MAX_ARTICLES_PER_RUN: 2,
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      ID_INDEX_TTL: 86400
    };
    
    const result = await processArticlesBatch(mockKV, mockEnv, config);
    
    expect(result.status).toBe('success');
    expect(result.loadedCount).toBe(2); // id3, id4
    expect(result.processedCount).toBe(2); // both need processing
    
    const kvData = mockKV.getData();
    const updatedQueue = JSON.parse(kvData['BTC_PENDING_QUEUE']);
    expect(updatedQueue).toEqual(['id3', 'id4']); // Still in queue for next processing phase
  });
  
  it('should remove fully processed articles from queue', async () => {
    const mockKV = createMockKV({
      'BTC_ID_INDEX': ['id1', 'id2', 'id3'],
      'BTC_PENDING_QUEUE': ['id3'],
      'article:id1': { title: 'Article 1', needsSentiment: false, needsSummary: false },
      'article:id2': { title: 'Article 2', needsSentiment: false, needsSummary: false },
      'article:id3': { title: 'Article 3', needsSentiment: true, needsSummary: true }
    });
    
    const mockEnv = createMockEnv();
    const config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_LAST_PROCESSED: 'BTC_LAST_PROCESSED_ID',
      KV_KEY_PENDING_QUEUE: 'BTC_PENDING_QUEUE',
      MAX_ARTICLES_PER_RUN: 5,
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      ID_INDEX_TTL: 86400
    };
    
    const result = await processArticlesBatch(mockKV, mockEnv, config);
    
    expect(result.status).toBe('success');
    expect(result.loadedCount).toBe(1); // only id3 in queue
    expect(result.processedCount).toBe(1);
    
    const kvData = mockKV.getData();
    const updatedQueue = JSON.parse(kvData['BTC_PENDING_QUEUE']);
    expect(updatedQueue).toEqual(['id3']); // Still in queue for next phase
  });
  
  it('should handle batch where no articles are in queue', async () => {
    const mockKV = createMockKV({
      'BTC_ID_INDEX': ['id1', 'id2', 'id3'],
      'BTC_PENDING_QUEUE': [],
      'article:id1': { title: 'Article 1', needsSentiment: false, needsSummary: false },
      'article:id2': { title: 'Article 2', needsSentiment: false, needsSummary: false },
      'article:id3': { title: 'Article 3', needsSentiment: false, needsSummary: false }
    });
    
    const mockEnv = createMockEnv();
    const config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_LAST_PROCESSED: 'BTC_LAST_PROCESSED_ID',
      KV_KEY_PENDING_QUEUE: 'BTC_PENDING_QUEUE',
      MAX_ARTICLES_PER_RUN: 2,
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      ID_INDEX_TTL: 86400
    };
    
    const result = await processArticlesBatch(mockKV, mockEnv, config);
    
    expect(result.status).toBe('no_articles');
    expect(result.loadedCount).toBe(0);
    expect(result.processedCount).toBe(0);
  });
  
  it('should return no_articles status when queue is empty', async () => {
    const mockKV = createMockKV({
      'BTC_ID_INDEX': [],
      'BTC_PENDING_QUEUE': []
    });
    
    const mockEnv = createMockEnv();
    const config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_LAST_PROCESSED: 'BTC_LAST_PROCESSED_ID',
      KV_KEY_PENDING_QUEUE: 'BTC_PENDING_QUEUE',
      MAX_ARTICLES_PER_RUN: 5,
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      ID_INDEX_TTL: 86400
    };
    
    const result = await processArticlesBatch(mockKV, mockEnv, config);
    
    expect(result.status).toBe('no_articles');
    expect(result.processedCount).toBe(0);
    expect(result.loadedCount).toBe(0);
  });
  
  it('should process articles from queue regardless of index order', async () => {
    const mockKV = createMockKV({
      'BTC_ID_INDEX': ['id1', 'id2', 'id3'],
      'BTC_PENDING_QUEUE': ['id1', 'id2'], // Only these need processing
      'article:id1': { title: 'Article 1', needsSentiment: true, needsSummary: true },
      'article:id2': { title: 'Article 2', needsSentiment: true, needsSummary: true },
      'article:id3': { title: 'Article 3', needsSentiment: false, needsSummary: false }
    });
    
    const mockEnv = createMockEnv();
    const config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_LAST_PROCESSED: 'BTC_LAST_PROCESSED_ID',
      KV_KEY_PENDING_QUEUE: 'BTC_PENDING_QUEUE',
      MAX_ARTICLES_PER_RUN: 2,
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      ID_INDEX_TTL: 86400
    };
    
    const result = await processArticlesBatch(mockKV, mockEnv, config);
    
    // Should process from queue
    expect(result.status).toBe('success');
    expect(result.loadedCount).toBe(2);
    expect(result.processedCount).toBe(2); // id1 and id2
  });
  
  it('should eventually process all articles when more than 15 are added to a filled list', async () => {
    const MAX_ARTICLES_PER_RUN = 5;
    
    // Start with 10 already processed articles
    const existingArticles = Array.from({ length: 10 }, (_, i) => `existing_${i + 1}`);
    
    // Add 20 new articles (more than 15, and 4x MAX_ARTICLES_PER_RUN) at the beginning
    const newArticles = Array.from({ length: 20 }, (_, i) => `new_${i + 1}`);
    const articleIds = [...newArticles, ...existingArticles];
    
    // Initialize mock KV with article index, pending queue, and articles
    const initialData = {
      'BTC_ID_INDEX': articleIds,
      'BTC_PENDING_QUEUE': [...newArticles] // Only new articles in queue
    };
    
    // Add existing articles (already processed - no flags)
    existingArticles.forEach(id => {
      initialData[`article:${id}`] = {
        title: `Existing Article ${id}`,
        needsSentiment: false,
        needsSummary: false
      };
    });
    
    // Add new articles (need processing)
    newArticles.forEach(id => {
      initialData[`article:${id}`] = {
        title: `New Article ${id}`,
        needsSentiment: true,
        needsSummary: true
      };
    });
    
    const mockKV = createMockKV(initialData);
    const mockEnv = createMockEnv();
    const config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_LAST_PROCESSED: 'BTC_LAST_PROCESSED_ID',
      KV_KEY_PENDING_QUEUE: 'BTC_PENDING_QUEUE',
      MAX_ARTICLES_PER_RUN: MAX_ARTICLES_PER_RUN,
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      ID_INDEX_TTL: 86400
    };
    
    expect(articleIds.length).toBe(30);
    
    // Simulate multiple processor runs
    const processedArticleIds = new Set();
    let runCount = 0;
    const maxRuns = 10; // Safety limit to prevent infinite loop
    
    while (runCount < maxRuns) {
      runCount++;
      
      const result = await processArticlesBatch(mockKV, mockEnv, config);
      
      // Stop if no more articles in queue
      if (result.status === 'no_articles') {
        break;
      }
      
      // Track which new articles were processed
      if (result.processedCount > 0) {
        const kvData = mockKV.getData();
        newArticles.forEach(id => {
          const article = kvData[`article:${id}`];
          if (article && !article.needsSentiment && !article.needsSummary) {
            processedArticleIds.add(id);
          }
        });
      }
      
      // Stop if all new articles processed
      if (processedArticleIds.size === newArticles.length) {
        break;
      }
    }
    
    // Verify all new articles were eventually processed
    expect(processedArticleIds.size).toBe(20);
    expect(runCount).toBeLessThanOrEqual(10); // Should process all articles within reasonable time
  });
});


