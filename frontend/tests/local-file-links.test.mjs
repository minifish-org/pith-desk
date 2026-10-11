import test from 'node:test';
import assert from 'node:assert/strict';
import { localFilePath } from '../src/local-file-links.ts';

test('reply file links preserve Unicode, spaces and URL-encoded filename characters', () => {
  for (const [href, expected] of [
    ['output/报告.docx', 'output/报告.docx'],
    ['output/报告%20v1.docx', 'output/报告 v1.docx'],
    ['output/a%23b%3Fc.docx?download=1#page', 'output/a#b?c.docx'],
    ['/tmp/work/output/report.pdf', '/tmp/work/output/report.pdf'],
    ['file:///tmp/work/report%20v1.docx', '/tmp/work/report v1.docx'],
    ['file://localhost/tmp/work/report.docx', '/tmp/work/report.docx'],
    ['output/100%.pdf', 'output/100%.pdf'],
  ]) assert.equal(localFilePath(href), expected);
});

test('external, executable, remote-share and empty links are not local downloads', () => {
  for (const href of ['', '#heading', '?query', 'https://example.com/file.docx', 'mailto:a@example.com', '//example.com/file.docx', 'file://other-host/share/file.docx', 'javascript:alert(1)', 'data:text/html,test', 'sandbox:/mnt/data/report.docx', 'output/%00report.docx', 'a\nb.docx', 'C:\\report.docx']) {
    assert.equal(localFilePath(href), null, href);
  }
});
