import {useEffect, useRef, useState} from 'react';
import {Download} from 'lucide-react';
import {closeModalId, useDesk, type ModalOf} from '@/stores/desk.ts';
import {editorValues, submitMessageEdit, submitQueueEdit} from '@/actions/message-edits.ts';
import {saveBlob} from '@/lib/save.ts';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';

export function EditorDialog({modal}: {modal: ModalOf<'editor'>}) {
  const [value, setValue] = useState(modal.value);
  const [busy, setBusy] = useState(false);
  const state = useDesk(store => store.state);
  const ref = useRef<HTMLTextAreaElement>(null);
  const invalid = modal.conversationId !== undefined && modal.conversationId !== state.activeId
    ? true
    : modal.slot === 'message'
      ? !!modal.expectedLastMessageId && state.messages.at(-1)?.id !== modal.expectedLastMessageId
      : !state.queuedMessages.some(entry => entry.id === modal.targetId);
  useEffect(() => {editorValues.set(modal.id, value);}, [modal.id, value]);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(value.length, value.length);
  }, []);
  useEffect(() => {
    return () => {editorValues.delete(modal.id);};
  }, [modal.id]);
  return (
    <Dialog open onOpenChange={open => {if (!open && !busy) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-xl" data-text-edit="">
        <DialogHeader><DialogTitle>{modal.title}</DialogTitle></DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async event => {
            event.preventDefault();
            setBusy(true);
            try {
              if (modal.slot === 'queue') await submitQueueEdit(modal.id, value, modal.targetId);
              else await submitMessageEdit(modal.id, modal.targetId, value);
            } finally {setBusy(false);}
          }}
        >
          <Textarea
            ref={ref} aria-label={modal.title} value={value} rows={7} className="min-h-40 resize-y font-normal"
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {modal.note ? <p className="text-[11px] leading-relaxed text-muted-foreground">{modal.note}</p> : null}
          {modal.error ? <p className="text-[12px] text-destructive" role="alert">{modal.error}</p> : null}
          {invalid && !modal.error ? <p className="text-[12px] text-destructive" role="alert">The conversation changed. Reopen the message to send this edit. Your text is kept here so you can copy it.</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => closeModalId(modal.id)}>Cancel</Button>
            <Button type="submit" disabled={busy || invalid || (!value.trim() && !modal.note?.includes('image'))}>{modal.submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RecoveredDialog({modal}: {modal: ModalOf<'recovered'>}) {
  const download = () => {void saveBlob(new Blob([modal.text], {type: 'text/plain;charset=utf-8'}), 'pith-desk-unsent-text.txt');};
  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Recovered unsent text</DialogTitle>
          <DialogDescription className="leading-relaxed">
            This page kept text that could not be confirmed as saved. Copy or download it before discarding. Check the current conversation and queue before submitting again; nothing is sent automatically.
          </DialogDescription>
        </DialogHeader>
        <Textarea readOnly value={modal.text} aria-label="Recovered unsent text" className="h-48 font-mono text-[12px]" />
        <DialogFooter>
          <Button variant="secondary" onClick={download}><Download className="size-3.5" />Download text</Button>
          <Button variant="secondary" onClick={() => closeModalId(modal.id)}>Discard copy</Button>
          <Button onClick={() => closeModalId(modal.id)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
