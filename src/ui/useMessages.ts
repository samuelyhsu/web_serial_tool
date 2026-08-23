import { useMemo } from 'react';
import { messagesFor, type Messages } from '@/i18n';
import { useUiStore } from '@/store/uiStore';

export function useMessages(): Messages {
  const language = useUiStore((state) => state.language);
  return useMemo(() => messagesFor(language), [language]);
}
