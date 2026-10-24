import {X} from 'lucide-react';
import {closeModalId, type ModalOf} from '@/stores/desk.ts';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';

export function ImageDialog({modal}: {modal: ModalOf<'image'>}) {
  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-[min(92vw,1100px)] p-2" aria-describedby={undefined} onCloseAutoFocus={event => event.preventDefault()}>
        <DialogHeader className="sr-only"><DialogTitle>{modal.alt}</DialogTitle></DialogHeader>
        <div className="grid max-h-[80dvh] place-items-center overflow-auto rounded-md bg-muted/40">
          <img src={modal.src} alt={modal.alt} className="max-h-[78dvh] max-w-full object-contain" />
        </div>
        <DialogFooter className="sm:justify-end">
          <Button variant="ghost" size="sm" onClick={() => closeModalId(modal.id)}><X className="size-3.5" />Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
