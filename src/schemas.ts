import { z } from 'zod';

// --- Constants ---

export const stickyNoteColors = [
  'gray',
  'light_yellow',
  'yellow',
  'orange',
  'light_green',
  'green',
  'dark_green',
  'cyan',
  'light_pink',
  'pink',
  'violet',
  'red',
  'light_blue',
  'blue',
  'dark_blue',
  'black',
] as const;

export const shapeTypes = [
  'rectangle',
  'round_rectangle',
  'circle',
  'triangle',
  'rhombus',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'octagon',
  'wedge_round_rectangle_callout',
  'star',
  'flow_chart_predefined_process',
  'cloud',
  'cross',
  'can',
  'right_arrow',
  'left_arrow',
  'left_right_arrow',
  'left_brace',
  'right_brace',
  'flow_chart_connector',
  'flow_chart_magnetic_disk',
  'flow_chart_input_output',
  'flow_chart_decision',
  'flow_chart_delay',
  'flow_chart_display',
  'flow_chart_document',
  'flow_chart_magnetic_drum',
  'flow_chart_internal_storage',
  'flow_chart_manual_input',
  'flow_chart_manual_operation',
  'flow_chart_merge',
  'flow_chart_multidocuments',
  'flow_chart_note_curly_left',
  'flow_chart_note_curly_right',
  'flow_chart_note_square',
  'flow_chart_offpage_connector',
  'flow_chart_or',
  'flow_chart_predefined_process_2',
  'flow_chart_preparation',
  'flow_chart_process',
  'flow_chart_online_storage',
  'flow_chart_summing_junction',
  'flow_chart_terminator',
] as const;

export const STICKY_SIZE_PRESETS: Record<string, number> = {
  klitzeklein: 325,
  klein: 650,
  medium: 1300,
  mittelgroß: 2600,
  groß: 5600,
  riesengroß: 11200,
};

export const stickySizeNames = Object.keys(STICKY_SIZE_PRESETS) as [
  string,
  ...string[],
];

// --- Zod Schemas ---

export const createStickyNoteSchema = {
  boardId: z.string().describe('ID of the board to create the sticky note on'),
  content: z.string().describe('Text content of the sticky note'),
  color: z
    .enum(stickyNoteColors)
    .default('yellow')
    .describe('Color of the sticky note'),
  x: z.number().default(0).describe('X coordinate position'),
  y: z.number().default(0).describe('Y coordinate position'),
  size: z
    .enum(stickySizeNames)
    .optional()
    .describe(
      'Named size preset: klitzeklein (325), klein (650), medium (1300), mittelgroß (2600), groß (5600), riesengroß (11200). Sets shape to rectangle automatically.',
    ),
  width: z
    .number()
    .optional()
    .describe(
      'Custom width in pixels (overrides size preset if both provided). Default square is 199px.',
    ),
  shape: z
    .enum(['square', 'rectangle'])
    .default('square')
    .describe(
      "Sticky note shape: 'square' (default, 1:1.15 ratio) or 'rectangle' (1:0.65 ratio). Auto-set to rectangle when using size presets.",
    ),
  parentId: z
    .string()
    .optional()
    .describe(
      "ID of the parent frame to place the sticky note inside. Coordinates become relative to the frame's top-left corner.",
    ),
};

export const bulkCreateItemsSchema = {
  boardId: z.string().describe('ID of the board to create the items on'),
  items: z
    .array(
      z.object({
        type: z
          .enum([
            'app_card',
            'text',
            'shape',
            'sticky_note',
            'image',
            'document',
            'card',
            'frame',
            'embed',
          ])
          .describe('Type of item to create'),
        data: z
          .record(z.string(), z.any())
          .optional()
          .describe('Item-specific data configuration'),
        style: z
          .record(z.string(), z.any())
          .optional()
          .describe('Item-specific style configuration'),
        position: z
          .record(z.string(), z.any())
          .optional()
          .describe('Item position {x, y}'),
        geometry: z
          .record(z.string(), z.any())
          .optional()
          .describe('Item geometry configuration'),
        parent: z
          .record(z.string(), z.any())
          .optional()
          .describe('Parent frame: {id: frameId}'),
        size: z
          .enum(stickySizeNames)
          .optional()
          .describe(
            'Size preset for sticky notes (same as create_sticky_note). Auto-sets shape to rectangle.',
          ),
        width: z.number().optional().describe('Custom width for sticky notes'),
        color: z.string().optional().describe('Shorthand for style.fillColor'),
      }),
    )
    .min(1)
    .max(20)
    .describe('Array of items to create'),
};

export const getFramesSchema = {
  boardId: z.string().describe('ID of the board to get frames from'),
};

export const getItemsInFrameSchema = {
  boardId: z.string().describe('ID of the board that contains the frame'),
  frameId: z.string().describe('ID of the frame to get items from'),
};

export const createShapeSchema = {
  boardId: z.string().describe('ID of the board to create the shape on'),
  shape: z
    .enum(shapeTypes)
    .default('rectangle')
    .describe('Type of shape to create'),
  content: z
    .string()
    .optional()
    .describe('Text content to display on the shape'),
  style: z
    .object({
      borderColor: z.string().optional(),
      borderOpacity: z.number().min(0).max(1).optional(),
      borderStyle: z.enum(['normal', 'dotted', 'dashed']).optional(),
      borderWidth: z.number().min(1).max(24).optional(),
      color: z.string().optional(),
      fillColor: z.string().optional(),
      fillOpacity: z.number().min(0).max(1).optional(),
      fontFamily: z.string().optional(),
      fontSize: z.number().min(10).max(288).optional(),
      textAlign: z.enum(['left', 'center', 'right']).optional(),
      textAlignVertical: z.enum(['top', 'middle', 'bottom']).optional(),
    })
    .optional()
    .describe('Style configuration for the shape'),
  position: z
    .object({
      x: z.number().default(0),
      y: z.number().default(0),
      origin: z.string().default('center'),
    })
    .optional()
    .describe('Position configuration'),
  geometry: z
    .object({
      width: z.number().default(200),
      height: z.number().default(200),
      rotation: z.number().default(0),
    })
    .optional()
    .describe('Geometry configuration'),
};

export const getBoardAccessSchema = {
  boardId: z.string().describe('ID of the board to get access information for'),
};

export const updateBoardSharingSchema = {
  boardId: z
    .string()
    .describe('ID of the board to update sharing settings for'),
  access: z
    .enum(['private', 'view', 'comment', 'edit'])
    .optional()
    .describe('Board access level: private, view, comment, or edit'),
  teamAccess: z
    .enum(['private', 'view', 'comment', 'edit'])
    .optional()
    .describe('Team access level: private, view, comment, or edit'),
  organizationAccess: z
    .enum(['private', 'view', 'comment', 'edit'])
    .optional()
    .describe('Organization access level: private, view, comment, or edit'),
  inviteToAccountAndBoardLinkAccess: z
    .enum(['viewer', 'commenter', 'editor', 'no_access'])
    .optional()
    .describe(
      'API-level access for anyone with the board link. May be restricted by organization settings. This does NOT control UI-generated share links (with share_link_id).',
    ),
};

export const getBoardShareLinkSchema = {
  boardId: z.string().describe('ID of the board to get the view link for'),
};
