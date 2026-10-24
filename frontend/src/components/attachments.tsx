import {DndContext, closestCenter, type DragEndEvent} from '@dnd-kit/core';
import {SortableContext, arrayMove, horizontalListSortingStrategy, useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {desk, type DraftImage} from '@/stores/desk.ts';
import {rememberDraft, removeAttachment} from '@/actions/composer.ts';
import {Button} from '@/components/ui/button';

/** Reorderable image attachments in the composer. */
export function DraftAttachments({images, disabled}: {images: DraftImage[]; disabled: boolean}) {
  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over;
    if (!over || event.active.id === over.id) return;
    const from = images.findIndex(image => image.id === event.active.id);
    const to = images.findIndex(image => image.id === over.id);
    if (from < 0 || to < 0) return;
    desk().setComposer({images: arrayMove(images, from, to)});
    rememberDraft();
  };
  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={images.map(image => image.id)} strategy={horizontalListSortingStrategy}>
        <div data-draft-images="" className="flex gap-2 overflow-x-auto px-3 pt-3">
          {images.map(image => <SortableAttachment key={image.id} image={image} disabled={disabled} />)}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableAttachment({image, disabled}: {image: DraftImage; disabled: boolean}) {
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: image.id, disabled});
  return (
    <figure
      ref={setNodeRef}
      style={{transform: CSS.Transform.toString(transform), transition}}
      data-draft-image=""
      className={cn('relative w-[104px] shrink-0', isDragging && 'z-10 opacity-80')}
      {...attributes}
      {...listeners}
    >
      <button
        type="button" aria-label={`Open ${image.name}`} className="block"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          const trigger = event.currentTarget;
          desk().openModal({kind: 'image', id: `draft-${image.id}`, src: image.url, alt: image.name, onClose: () => requestAnimationFrame(() => trigger.focus())});
        }}
      >
        <img src={image.url} alt="" className="h-20 w-[104px] rounded-lg border object-cover" />
      </button>
      <figcaption className="truncate pt-1 text-[11px] text-muted-foreground">{image.name}</figcaption>
      <Button
        type="button" variant="secondary" size="icon-xs"
        className="absolute top-1 right-1 size-5 rounded-full shadow"
        aria-label={`Remove ${image.name}`}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => removeAttachment(image.id)}
      >
        <X className="size-3" />
      </Button>
    </figure>
  );
}
