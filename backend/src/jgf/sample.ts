import type { JgfDocument } from '@simplearchitecture/shared';

/** A small, made-up model for `GET /api/export/jgf` until models are stored. */
export const sampleModel: JgfDocument = {
  graph: {
    id: 'sample-model',
    label: 'Sample model (made up)',
    directed: true,
    nodes: {
      customer: {
        label: 'Customer',
        metadata: { type: 'Stakeholder', description: 'Someone who buys from the shop.' },
      },
      'order-handling': {
        label: 'Order handling',
        metadata: {
          type: 'Business',
          description: 'Taking and fulfilling orders.',
          owningTeam: 'Sales',
        },
      },
      'web-shop': {
        label: 'Web shop',
        metadata: {
          type: 'Application',
          description: 'Where customers place orders.',
          architectureState: 'Current',
          functions: ['Product catalogue', 'Checkout'],
          owningTeam: 'Shop team',
          sourcing: 'Build',
          supplierHqCountry: 'NL',
        },
      },
      'payment-service': {
        label: 'Payment service',
        metadata: {
          type: 'Application',
          architectureState: 'Target',
          functions: ['Card payments'],
          owningTeam: 'Payments team',
          sourcing: 'Buy',
          supplierHqCountry: 'SE',
          contractEnds: '2027-12-31',
        },
      },
      'cloud-platform': {
        label: 'Cloud platform',
        metadata: {
          type: 'Infrastructure',
          architectureState: 'Current',
          functions: [],
          owningTeam: 'Platform team',
          supplierHqCountry: 'US',
        },
      },
      'privacy-policy': {
        label: 'Privacy policy',
        metadata: { type: 'Other', description: 'Rules for handling personal data.' },
      },
    },
    edges: [
      {
        id: 'customer-to-shop',
        source: 'customer',
        target: 'web-shop',
        relation: 'Relation',
        directed: true,
        label: 'Orders',
        metadata: {
          requestData: 'Orders',
          responseData: 'Order numbers',
          identity: 'Signed-in customer',
        },
      },
      {
        id: 'shop-to-payments',
        source: 'web-shop',
        target: 'payment-service',
        relation: 'Relation',
        directed: true,
        label: 'Payment API',
        metadata: { architectureState: 'Current', protocol: 'HTTPS' },
      },
      {
        id: 'shop-to-orders',
        source: 'web-shop',
        target: 'order-handling',
        relation: 'Relation',
        directed: true,
        label: 'Order details',
        metadata: { architectureState: 'Target', requestData: 'Order details' },
      },
    ],
  },
};
