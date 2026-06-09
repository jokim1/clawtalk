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
});
