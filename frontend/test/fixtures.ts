import type { JgfDocument, ModelSummary } from '@simplearchitecture/shared';

/** Made-up models for tests. Nothing here comes from a real model. */

export const bakeryId = '11111111-1111-4111-8111-111111111111';
export const pilotId = '22222222-2222-4222-8222-222222222222';

export const bakerySummary: ModelSummary = {
  id: bakeryId,
  name: 'Bakery landscape',
  createdAt: '2026-10-26T14:05:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 7,
  edgeCount: 8,
};

export const pilotSummary: ModelSummary = {
  id: pilotId,
  name: 'Payments pilot',
  createdAt: '2026-10-24T09:12:00.000Z',
  createdBy: { id: 'u2', name: 'Sam Kim' },
  nodeCount: 38,
  edgeCount: 51,
};

/**
 * A small bakery: a customer, an ordering process, three applications (one with an id that
 * needs URL encoding), a server and a lonely element.
 */
export const bakeryModel: JgfDocument = {
  graph: {
    id: bakeryId,
    label: 'Bakery landscape',
    directed: true,
    nodes: {
      customer: {
        label: 'Customer',
        metadata: { type: 'Stakeholder', description: 'Buys bread.' },
      },
      ordering: {
        label: 'Order to bake',
        metadata: { type: 'Business', owningTeam: 'Front shop', archimateType: 'BusinessProcess' },
      },
      shop: {
        label: 'Web Shop',
        metadata: {
          type: 'Application',
          description:
            'Takes orders online.\nRunbook: https://wiki.example.com/shop and <b>bold</b> javascript:alert(1)',
          architectureState: 'Current',
          sourcing: 'Buy',
          supplierHqCountry: 'NL',
          owningTeam: 'Web team',
          functions: ['Order capture', 'Payment'],
          archimateType: 'ApplicationComponent',
          hostingModel: 'SaaS',
        },
      },
      'oven/planner #1': {
        label: 'Oven Planner',
        metadata: {
          type: 'Application',
          architectureState: 'Target',
          supplierHqCountry: 'Holland',
          functions: ['Plan batches'],
        },
      },
      till: {
        label: 'Till',
        metadata: { type: 'Application', architectureState: 'Deprecate' },
      },
      server: {
        label: 'Back Office Server',
        metadata: { type: 'Infrastructure', architectureState: 'Current' },
      },
      lonely: { label: 'Recipe Archive', metadata: { type: 'Other' } },
    },
    edges: [
      {
        id: 'e1',
        source: 'customer',
        target: 'shop',
        relation: 'Relation',
        metadata: { requestData: ['Places orders'] },
        label: 'Places orders',
      },
      {
        id: 'e2',
        source: 'shop',
        target: 'ordering',
        relation: 'Relation',
      },
      {
        id: 'e3',
        source: 'shop',
        target: 'oven/planner #1',
        relation: 'Relation',
        metadata: { requestData: ['Orders'] },
        label: 'Orders',
      },
      {
        id: 'e4',
        source: 'shop',
        target: 'oven/planner #1',
        relation: 'Relation',
        label: 'REST API',
      },
      {
        id: 'e5',
        source: 'till',
        target: 'shop',
        relation: 'Relation',
      },
      {
        id: 'e6',
        source: 'oven/planner #1',
        target: 'server',
        relation: 'Relation',
      },
      { id: 'e7', source: 'shop', target: 'server', relation: 'Relation', label: 'Hosted on' },
      {
        id: 'e8',
        source: 'shop',
        target: 'oven/planner #1',
        relation: 'Relation',
      },
      {
        id: 'e9',
        source: 'shop',
        target: 'server',
        relation: 'Relation',
      },
    ],
  },
};
