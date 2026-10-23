import {cn} from '@/lib/utils';

export function BrandMark({className}: {className?: string}) {
  return (
    <span data-brand-mark="" aria-hidden="true" className={cn('brand-mark', className)}>
      <i /><i /><i /><i />
    </span>
  );
}
