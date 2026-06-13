import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './renderMarkdown';

describe('renderMarkdown', () => {
  it('renders bold, emphasis, links, and ordered lists without raw HTML', () => {
    render(
      <div>
        {renderMarkdown(
          [
            '**Thesis:** lead with *pricing* proof.',
            '',
            '1. Visit [Notion](https://notion.example/path).',
            '2. Keep <script>alert("x")</script> as text.',
          ].join('\n'),
        )}
      </div>,
    );

    expect(screen.getByText('Thesis:').tagName).toBe('STRONG');
    expect(screen.getByText('pricing').tagName).toBe('EM');
    expect(screen.getByRole('link', { name: 'Notion' })).toHaveAttribute(
      'href',
      'https://notion.example/path',
    );
    expect(screen.getByText(/<script>alert/)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });

  it('renders links wrapped in bold or emphasis as clickable anchors', () => {
    // Prod regression: the agent emits list items as `**[text](url)**`.
    // The bold rule used to swallow the inner link as raw text.
    render(
      <div>
        {renderMarkdown(
          [
            '1. **[Cal commitments](https://sportspyder.example/cf/news)** — recruiting',
            '2. *[Spring game recap](https://bearinsider.example/recap)* — roundup',
          ].join('\n'),
        )}
      </div>,
    );

    const boldLink = screen.getByRole('link', { name: 'Cal commitments' });
    expect(boldLink).toHaveAttribute(
      'href',
      'https://sportspyder.example/cf/news',
    );
    expect(boldLink.closest('strong')).not.toBeNull();

    const emLink = screen.getByRole('link', { name: 'Spring game recap' });
    expect(emLink).toHaveAttribute('href', 'https://bearinsider.example/recap');
    expect(emLink.closest('em')).not.toBeNull();

    // The raw markdown brackets must not survive into the rendered text.
    expect(screen.queryByText(/\]\(https/)).toBeNull();
  });
});
