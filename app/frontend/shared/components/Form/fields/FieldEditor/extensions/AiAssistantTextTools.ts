// Copyright (C) 2012-2026 Zammad Foundation, https://zammad-foundation.org/

import { Extension, Editor } from '@tiptap/core'
import { effectScope, ref, type Ref, watch } from 'vue'

import {
  NotificationTypes,
  useNotifications,
} from '#shared/components/CommonNotifications/index.ts'
import { useAiAssistanceTextToolsListQuery } from '#shared/components/Form/fields/FieldEditor/graphql/queries/aiAssistanceTextTools/aiAssistanceTextToolsList.api.ts'
import type { FieldEditorProps } from '#shared/components/Form/fields/FieldEditor/types.ts'
import {
  getHTMLContentBetweenSelection,
  updateSelectedContent,
} from '#shared/components/Form/fields/FieldEditor/utils.ts'
import type { FormFieldContext } from '#shared/components/Form/types/field.ts'
import { getNodeByName } from '#shared/components/Form/utils.ts'
import { useAiAssistanceTextToolsRunMutation } from '#shared/graphql/mutations/aiAssistanceTextToolsRun.api.ts'
import { convertToGraphQLId, ensureGraphqlId } from '#shared/graphql/utils.ts'
import { MutationHandler, QueryHandler } from '#shared/server/apollo/handler/index.ts'
import { useAiAssistantTextToolsStore } from '#shared/stores/aiAssistantTextTools.ts'
import { useApplicationStore } from '#shared/stores/application.ts'
import { GraphQLErrorTypes } from '#shared/types/error.ts'

import type { FormKitNode } from '@formkit/core'

interface AiTextToolsController {
  mutation: {
    textToolsMutation: MutationHandler<any, any>
    isLoading: Ref<boolean>
    abort: () => void
  }
  isCancelled: boolean
  cancel: () => void
  reset: () => void
  recreate: () => void
  cleanup: () => void
}

const createAiTextToolsController = (): AiTextToolsController => {
  let mutationCancelled = false
  let currentAbortController: AbortController | null = null

  const createAbortableMutation = () => {
    currentAbortController = new AbortController()
    const textToolsMutation = new MutationHandler(
      useAiAssistanceTextToolsRunMutation({
        context: { fetchOptions: { signal: currentAbortController.signal } },
      }),
      {
        errorNotificationMessage: __(
          'Writing assistant could not generate text. Please try again or contact your administrator.',
        ),
        errorCallback: (error) => {
          return !(mutationCancelled && error.type === GraphQLErrorTypes.NetworkError)
        },
      },
    )

    return {
      textToolsMutation,
      isLoading: textToolsMutation.loading(),
      abort: () => currentAbortController?.abort(),
    }
  }

  return {
    mutation: createAbortableMutation(),
    get isCancelled() {
      return mutationCancelled
    },
    cancel: () => {
      mutationCancelled = true
    },
    reset: () => {
      mutationCancelled = false
    },
    recreate() {
      this.mutation = createAbortableMutation()
    },
    cleanup() {
      currentAbortController?.abort()
      currentAbortController = null
    },
  }
}

const createLoaderHandler = (editor: Editor) => ({
  showActionBarAndHideLoader: () => {
    editor.setEditable(true)
    editor.storage.showAiTextLoader = false
  },
  hideActionBarAndShowLoader: () => {
    editor.setEditable(false)
    editor.storage.showAiTextLoader = true
  },
})

const getFormRenderContext = async (context: Ref<FormFieldContext<FieldEditorProps>>) => {
  const { formId, ticketId, meta: editorMeta } = context.value
  const meta = editorMeta?.[EXTENSION_NAME] || {}

  let { customerId, groupId, organizationId } = context.value

  if (!customerId && meta.customerNodeName) {
    customerId = getNodeByName(formId, meta.customerNodeName)?.value as string
  }

  if (!organizationId && meta.organizationNodeName) {
    organizationId = getNodeByName(formId, meta.organizationNodeName)?.value as string
  }

  if (!groupId && meta.groupNodeName) {
    groupId = getNodeByName(formId, meta.groupNodeName)?.value as string
  }

  return {
    customerId: customerId ? ensureGraphqlId('User', customerId) : undefined,
    groupId: groupId ? ensureGraphqlId('Group', groupId) : undefined,
    organizationId: organizationId ? ensureGraphqlId('Organization', organizationId) : undefined,
    ticketId: ticketId ? ensureGraphqlId('Ticket', ticketId) : undefined,
  }
}

const sendTextToolsMutation = async (
  textToolId: ID,
  input: string,
  controller: AiTextToolsController,
  context: Ref<FormFieldContext<FieldEditorProps>>,
) => {
  const contextData = await getFormRenderContext(context)

  const response = await controller.mutation.textToolsMutation.send({
    input,
    textToolId,
    templateRenderContext: contextData,
  })

  return response?.aiAssistanceTextToolsRun?.output
}

type EditorEventCleanup = () => void

const setupEventHandlers = (
  editor: Editor,
  controller: AiTextToolsController,
): EditorEventCleanup => {
  const { notify } = useNotifications()

  const cancelHandler = () => {
    controller.cancel()
    controller.mutation.abort()
    controller.recreate()
    controller.reset()
  }

  const updateHandler = () => {
    if (controller.mutation.isLoading.value) {
      notify({
        id: 'ai-assistant-text-tools-aborted',
        type: NotificationTypes.Info,
        message: __('The text was modified. Your request has been aborted to prevent overwriting.'),
      })
      controller.mutation.abort()
      controller.recreate()
    }
  }

  editor.on('cancel-ai-assistant-text-tools-updates', cancelHandler)
  editor.on('update', updateHandler)

  return () => {
    editor.off('cancel-ai-assistant-text-tools-updates', cancelHandler)
    editor.off('update', updateHandler)
  }
}

const executeTextModification = async (
  textToolId: ID,
  editor: Editor,
  context: Ref<FormFieldContext<FieldEditorProps>>,
) => {
  const loadingHandlers = createLoaderHandler(editor)
  const controller = createAiTextToolsController()

  const normalizedRange = editor.state.selection
  const input = getHTMLContentBetweenSelection(editor, normalizedRange)

  loadingHandlers.hideActionBarAndShowLoader()
  const cleanupEventHandlers = setupEventHandlers(editor, controller)

  try {
    const output = await sendTextToolsMutation(textToolId, input, controller, context)
    if (!output) return

    editor.chain().focus().setTextSelection(normalizedRange).run()
    updateSelectedContent(editor, output)
  } catch {
    editor?.chain().focus().setTextSelection(normalizedRange).run()
  } finally {
    cleanupEventHandlers()
    controller.cleanup()
    loadingHandlers.showActionBarAndHideLoader()
    editor.chain().focus().run()
  }
}

export const EXTENSION_NAME = 'aiAssistantTextTools'

export default (context: Ref<FormFieldContext<FieldEditorProps>>) => {
  const { formId, ticketId, meta: editorMeta } = context.value
  const meta = editorMeta?.[EXTENSION_NAME] || {}
  let scope: ReturnType<typeof effectScope> | null = null
  let groupNodeCommitOff: (() => void) | null = null

  const cleanupScope = () => {
    if (groupNodeCommitOff) {
      groupNodeCommitOff()
      groupNodeCommitOff = null
    }
    if (scope?.active) {
      scope.stop()
    }
    scope = null
  }

  return Extension.create({
    name: EXTENSION_NAME,
    addStorage() {
      return {
        showAiTextLoader: false,
      }
    },
    onBeforeCreate({ editor }) {
      const { config } = useApplicationStore()

      watch(
        () => config.ai_assistance_text_tools,
        (newValue) => {
          if (!newValue) {
            cleanupScope()
            return
          }

          if (scope?.active) return

          scope = effectScope()

          scope.run(() => {
            const textToolsStore = useAiAssistantTextToolsStore()

            const groupNode = getNodeByName(formId, meta.groupNodeName!) as FormKitNode<number>

            const groupId = ref<number>(groupNode?.value)

            const commitReceipt = groupNode?.on('commit', ({ payload }) => {
              groupId.value = payload
            })

            if (commitReceipt) {
              groupNodeCommitOff = () => groupNode?.off(commitReceipt)
            }

            const queryHandler = new QueryHandler(
              useAiAssistanceTextToolsListQuery(() => ({
                groupId: groupId.value ? convertToGraphQLId('Group', groupId.value) : undefined,
                ticketId: ticketId ? convertToGraphQLId('Ticket', ticketId) : undefined,
              })),
            )

            queryHandler.watchOnResult(({ aiAssistanceTextToolsList }) => {
              if (!editor) return

              editor.emit('toggle-visibility', {
                name: EXTENSION_NAME,
                active: !!aiAssistanceTextToolsList.length,
              })
            })

            watch(
              () => groupId.value,
              (newGroupId, oldGroupId) => {
                if (oldGroupId !== newGroupId) textToolsStore.deactivate(oldGroupId)

                textToolsStore.activate(newGroupId, queryHandler)
              },
              { immediate: true },
            )

            editor.on('destroy', () => {
              textToolsStore.deactivate(groupId.value)
              cleanupScope()
            })
          })
        },
        { immediate: true },
      )
    },
    addCommands() {
      return {
        modifyTextWithAi:
          (textToolId) =>
          ({ editor }) => {
            executeTextModification(textToolId, editor, context)
            return true
          },
      }
    },
    addOptions() {
      return {
        permission: 'ticket.agent',
      }
    },
    onDestroy() {
      cleanupScope()
    },
  })
}
