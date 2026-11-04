import { describe, expect, it } from 'vitest';
import { packageUrl, webPackagesBom } from '../vite/third-party-licenses';

describe('the web app package list', () => {
  it('makes package URLs, with a scope encoded', () => {
    expect(packageUrl('react', '19.3.1')).toBe('pkg:npm/react@19.3.1');
    expect(packageUrl('@xyflow/react', '12.12.0')).toBe('pkg:npm/%40xyflow/react@12.12.0');
  });

  it('lists each package with its version and licence, as CycloneDX', () => {
    const bom = webPackagesBom([{ name: 'made-up', version: '1.2.3', license: 'MIT' }]);
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.components).toEqual([
      {
        type: 'library',
        'bom-ref': 'pkg:npm/made-up@1.2.3',
        name: 'made-up',
        version: '1.2.3',
        purl: 'pkg:npm/made-up@1.2.3',
        licenses: [{ license: { name: 'MIT' } }],
      },
    ]);
  });
});
