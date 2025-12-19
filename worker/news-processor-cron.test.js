/**
 * Test suite for News Processor Cron Worker
 * Tests for TextExtractor debug functionality
 */

import { describe, it, expect } from 'vitest';
import { TextExtractor, fetchArticleContent } from './news-processor-cron.js';

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
