/**********************************************************************
 * Copyright (C) 2023 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { KubernetesClient } from './kubernetes-client.js';
import type { ApiSenderType } from './api.js';
import type { ConfigurationRegistry } from './configuration-registry.js';
import { FilesystemMonitoring } from './filesystem-monitoring.js';
import {
  type V1Ingress,
  type Watch,
  type V1Deployment,
  type V1Service,
  type Context,
  type KubernetesObject,
  type Informer,
  type ObjectCache,
  KubeConfig,
} from '@kubernetes/client-node';
import * as clientNode from '@kubernetes/client-node';
import type { Telemetry } from '/@/plugin/telemetry/telemetry.js';
import * as fs from 'node:fs';
import type { V1Route } from './api/openshift-types.js';
import { KubernetesInformerManager } from './kubernetes-informer-registry.js';

const configurationRegistry: ConfigurationRegistry = {} as unknown as ConfigurationRegistry;
const informerManager: KubernetesInformerManager = new KubernetesInformerManager();
const fileSystemMonitoring: FilesystemMonitoring = new FilesystemMonitoring();
const telemetry: Telemetry = {
  track: vi.fn().mockImplementation(async () => {
    // do nothing
  }),
} as unknown as Telemetry;
const makeApiClientMock = vi.fn();
const getContextObjectMock = vi.fn();

class TestKubernetesClient extends KubernetesClient {
  public createWatchObject(): Watch {
    return super.createWatchObject();
  }

  public setCurrentNamespace(namespace: string): void {
    this.currentNamespace = namespace;
  }
}

function createTestClient(namespace?: string): TestKubernetesClient {
  const client = new TestKubernetesClient(
    apiSender,
    configurationRegistry,
    fileSystemMonitoring,
    informerManager,
    telemetry,
  );
  if (namespace) {
    client.setCurrentNamespace(namespace);
  }
  return client;
}

const apiSenderSendMock = vi.fn();
const apiSender: ApiSenderType = {
  send: apiSenderSendMock,
  receive: vi.fn(),
};

const context: Context = {
  cluster: 'cluster',
  name: 'name',
  user: 'user',
};

function mockContext() {
  const newContext: Context = {
    cluster: 'cluster1',
    name: 'name1',
    user: 'user',
  };
  getContextObjectMock.mockReturnValue(newContext);
}

const stopInformerMock = vi.fn();
const informer: Informer<KubernetesObject> & ObjectCache<KubernetesObject> = {
  start: vi.fn(),
  stop: stopInformerMock,
  on: (
    _verb: 'change' | 'add' | 'update' | 'delete' | 'error' | 'connect',
    _cb: clientNode.ObjectCallback<KubernetesObject>,
  ) => {},
  off: (
    _verb: 'change' | 'add' | 'update' | 'delete' | 'error' | 'connect',
    _cb: clientNode.ObjectCallback<KubernetesObject>,
  ) => {},
  get: vi.fn(),
  list: vi.fn(),
};

beforeAll(() => {
  vi.mock('@kubernetes/client-node', async () => {
    return {
      KubeConfig: vi.fn(),
      CoreV1Api: {},
      AppsV1Api: {},
      CustomObjectsApi: {},
      NetworkingV1Api: {},
      VersionApi: {},
      makeInformer: vi.fn(),
      KubernetesObjectApi: vi.fn(),
    };
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  KubeConfig.prototype.loadFromFile = vi.fn();
  KubeConfig.prototype.makeApiClient = makeApiClientMock;
  KubeConfig.prototype.getContextObject = getContextObjectMock;
  KubeConfig.prototype.currentContext = 'context';
});

test('Create Kubernetes resources with empty should return ok', async () => {
  const client = createTestClient();
  await client.createResources('dummy', []);
  expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', { action: 'create', manifestsSize: 0 });
});

test('Create Kubernetes resources with v1 resource should return ok', async () => {
  const client = createTestClient();
  const readMock = vi.fn().mockRejectedValue(new Error('ResourceDoesntExistError'));
  const createMock = vi.fn().mockReturnValue({});
  makeApiClientMock.mockReturnValue({
    read: readMock,
    create: createMock,
  });
  await client.createResources('dummy', [{ apiVersion: 'v1', kind: 'Namespace' }]);
  expect(createMock).toHaveBeenCalled();
  expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', { action: 'create', manifestsSize: 1 });
});

describe.each([
  { manifest: { apiVersion: 'apps/v1', kind: 'Deployment' }, namespace: undefined, expectedNamespace: 'default' },
  { manifest: { apiVersion: 'apps/v1', kind: 'Deployment' }, namespace: 'defaultns', expectedNamespace: 'defaultns' },
  {
    manifest: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { namespace: 'demons' } },
    namespace: undefined,
    expectedNamespace: 'demons',
  },
])(
  'Create Kubernetes resources with apps/v1 resource should return ok',
  ({ manifest, namespace, expectedNamespace }) => {
    test(`should use namespace ${expectedNamespace}`, async () => {
      const client = createTestClient();
      const readMock = vi.fn().mockRejectedValue(new Error('ResourceDoesntExistError'));
      const createMock = vi.fn().mockReturnValue({});
      makeApiClientMock.mockReturnValue({
        read: readMock,
        create: createMock,
      });

      await client.createResources('dummy', [manifest], namespace);
      expect(readMock).toHaveBeenCalled();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ namespace: expectedNamespace }) }),
      );
      expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', {
        action: 'create',
        manifestsSize: 1,
        namespace: namespace,
      });
    });
  },
);

describe.each([
  {
    manifest: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' },
    namespace: undefined,
    expectedNamespace: 'default',
  },
  {
    manifest: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' },
    namespace: 'defaultns',
    expectedNamespace: 'defaultns',
  },
  {
    manifest: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { namespace: 'demons' } },
    namespace: undefined,
    expectedNamespace: 'demons',
  },
])(
  'Create Kubernetes resources with networking.k8s.io/v1 resource should return ok',
  ({ manifest, namespace, expectedNamespace }) => {
    test(`should use namespace ${expectedNamespace}`, async () => {
      const client = createTestClient();
      const readMock = vi.fn().mockRejectedValue(new Error('ResourceDoesntExistError'));
      const createMock = vi.fn().mockReturnValue({});
      makeApiClientMock.mockReturnValue({
        read: readMock,
        create: createMock,
      });

      await client.createResources('dummy', [manifest], namespace);
      expect(readMock).toHaveBeenCalled();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ namespace: expectedNamespace }) }),
      );
      expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', {
        action: 'create',
        manifestsSize: 1,
        namespace: namespace,
      });
    });
  },
);

test('Create Kubernetes resources with v1 resource in error should return error', async () => {
  const client = createTestClient();
  const spy = vi.spyOn(client, 'createV1Resource').mockRejectedValue(new Error('V1Error'));
  try {
    await client.createResources('dummy', [{ apiVersion: 'v1', kind: 'Namespace' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(spy).toBeCalled();
    expect(err).to.be.a('Error');
    expect(err.message).equal('V1Error');
    expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', {
      action: 'create',
      manifestsSize: 1,
      error: new Error('V1Error'),
    });
  }
});

describe.each([
  {
    manifest: { apiVersion: 'group/v1', kind: 'Namespace' },
    namespace: undefined,
    expectedNamespace: 'default',
  },
  {
    manifest: { apiVersion: 'group/v1', kind: 'Namespace' },
    namespace: 'defaultns',
    expectedNamespace: 'defaultns',
  },
  {
    manifest: { apiVersion: 'group/v1', kind: 'Namespace', metadata: { namespace: 'demons' } },
    namespace: undefined,
    expectedNamespace: 'demons',
  },
])('Create custom Kubernetes resources should return ok', ({ manifest, namespace, expectedNamespace }) => {
  test(`should use namespace ${expectedNamespace}`, async () => {
    const client = createTestClient();
    const createMock = vi.fn().mockReturnValue({});
    const readMock = vi.fn().mockRejectedValue(new Error('ResourceDoesntExistError'));
    makeApiClientMock.mockReturnValue({
      read: readMock,
      create: createMock,
    });
    await client.createResources('dummy', [manifest], namespace);
    expect(readMock).toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ namespace: expectedNamespace }) }),
    );
    expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', {
      action: 'create',
      manifestsSize: 1,
      namespace: namespace,
    });
  });
});

test('Create custom Kubernetes resources in error should return error', async () => {
  const client = createTestClient();
  const spy = vi.spyOn(client, 'createCustomResource').mockRejectedValue(new Error('CustomError'));
  vi.spyOn(client, 'getAPIResource').mockReturnValue(
    Promise.resolve({ name: 'namespaces', namespaced: true, kind: 'Namespace', singularName: 'namespace', verbs: [] }),
  );
  try {
    await client.createResources('dummy', [{ apiVersion: 'group/v1', kind: 'Namespace' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(spy).toBeCalled();
    expect(err).to.be.a('Error');
    expect(err.message).equal('CustomError');
    expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', {
      action: 'create',
      manifestsSize: 1,
      error: new Error('CustomError'),
    });
  }
});

test('Create unknown custom Kubernetes resources should return error', async () => {
  const client = createTestClient();
  const createSpy = vi.spyOn(client, 'createCustomResource').mockReturnValue(Promise.resolve());
  const pluralSpy = vi.spyOn(client, 'getAPIResource').mockRejectedValue(new Error('CustomError'));
  try {
    await client.createResources('dummy', [{ apiVersion: 'group/v1', kind: 'Namespace' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(createSpy).not.toBeCalled();
    expect(pluralSpy).toBeCalled();
    expect(err).to.be.a('Error');
    expect(err.message).equal('CustomError');
    expect(telemetry.track).toHaveBeenCalledWith('kubernetesSyncResources', {
      action: 'create',
      manifestsSize: 1,
      error: new Error('CustomError'),
    });
  }
});

test('Check connection to Kubernetes cluster', async () => {
  // Mock k8sApi.getCode() to return the version of the cluster
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
  });

  const client = new KubernetesClient(
    {} as ApiSenderType,
    configurationRegistry,
    fileSystemMonitoring,
    informerManager,
    telemetry,
  );
  const result = await client.checkConnection();
  expect(result).toBeTruthy();
});

test('Check connection to Kubernetes cluster in error', async () => {
  // Mock k8sApi.getCode() to return the version of the cluster
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
  });

  const client = new KubernetesClient(
    {} as ApiSenderType,
    configurationRegistry,
    fileSystemMonitoring,
    informerManager,
    telemetry,
  );
  const result = await client.checkConnection();
  expect(result).toBeFalsy();
});

test('Check update with empty kubeconfig file', async () => {
  const readFileMock = vi.spyOn(fs.promises, 'readFile');
  const consoleErrorSpy = vi.spyOn(console, 'error');

  // provide empty kubeconfig file
  readFileMock.mockResolvedValue('');

  const client = new KubernetesClient(
    {} as ApiSenderType,
    configurationRegistry,
    fileSystemMonitoring,
    informerManager,
    telemetry,
  );
  await client.refresh();
  expect(consoleErrorSpy).toBeCalledWith(expect.stringContaining('is empty. Skipping'));
});

test('kube watcher', () => {
  const client = createTestClient('fooNS');
  const path: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errorHandler: any;

  // mock TestKubernetesClient.createWatchObject
  const watchMethodMock = vi.fn().mockImplementation((pathMethod, _ignore1, _ignore2, c) => {
    path.push(pathMethod);
    errorHandler = c;
    return Promise.resolve();
  });

  const createWatchObjectSpy = vi
    .spyOn(client, 'createWatchObject')
    .mockReturnValue({ watch: watchMethodMock } as unknown as Watch);

  client.setupKubeWatcher();

  expect(path).toContain('/api/v1/namespaces/fooNS/pods');
  expect(path).toContain('/apis/apps/v1/namespaces/fooNS/deployments');
  expect(errorHandler).toBeDefined();

  // call the error Handler with undefined
  if (errorHandler !== undefined) {
    errorHandler(undefined);
  }

  expect(createWatchObjectSpy).toBeCalled();
});

// Deployment
test('should return empty deployment list if there is no active namespace', async () => {
  const client = createTestClient();

  const list = await client.listDeployments();
  expect(list.length).toBe(0);
});

test('should return empty deployment list if cannot connect to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listDeployments();
  expect(list.length).toBe(0);
});

test('should return empty deployment list if cannot execute call to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedDeployent: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listDeployments();
  expect(list.length).toBe(0);
});

test('should return deployment list if connection to cluster is ok', async () => {
  const v1Deployment: V1Deployment = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Deployment',
    metadata: {
      name: 'deployment',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedDeployment: () =>
      Promise.resolve({
        body: {
          items: [v1Deployment],
        },
      }),
  });

  const list = await client.listDeployments();
  expect(list.length).toBe(1);
  expect(list[0].metadata?.name).toEqual('deployment');
});

test('should throw error if cannot call the cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedDeployment: () => Promise.reject(new Error('K8sError')),
  });

  try {
    await client.readNamespacedDeployment('deployment', 'default');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(err).to.be.a('Error');
    expect(err.message).equal('K8sError');
  }
});

test('should return undefined if deployment does not exist', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedDeployment: () => Promise.resolve({}),
  });

  const deployment = await client.readNamespacedDeployment('deployment', 'default');
  expect(deployment).not.toBeDefined();
});

test('should return deployment if it exists', async () => {
  const v1Deployment: V1Deployment = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Deployment',
    metadata: {
      name: 'deployment',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedDeployment: () =>
      Promise.resolve({
        body: v1Deployment,
      }),
  });

  const deployment = await client.readNamespacedDeployment('deployment', 'default');
  expect(deployment).toBeDefined();
  expect(deployment?.metadata?.name).toEqual('deployment');
});

// Ingress
test('should return empty ingress list if there is no active namespace', async () => {
  const client = createTestClient();

  const list = await client.listIngresses();
  expect(list.length).toBe(0);
});

test('should return empty ingress list if cannot connect to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listIngresses();
  expect(list.length).toBe(0);
});

test('should return empty ingress list if cannot execute call to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedIngress: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listIngresses();
  expect(list.length).toBe(0);
});

test('should return ingress list if connection to cluster is ok', async () => {
  const v1Ingress: V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'ingress',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedIngress: () =>
      Promise.resolve({
        body: {
          items: [v1Ingress],
        },
      }),
  });

  const list = await client.listIngresses();
  expect(list.length).toBe(1);
  expect(list[0].metadata?.name).toEqual('ingress');
});

test('should throw error if cannot call the cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedIngress: () => Promise.reject(new Error('K8sError')),
  });

  try {
    await client.readNamespacedIngress('ingress', 'default');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(err).to.be.a('Error');
    expect(err.message).equal('K8sError');
  }
});

test('should return undefined if ingress does not exist', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedIngress: () => Promise.resolve({}),
  });

  const ingress = await client.readNamespacedIngress('ingress', 'default');
  expect(ingress).not.toBeDefined();
});

test('should return ingress if it exists', async () => {
  const v1Ingress: V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'ingress',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedIngress: () =>
      Promise.resolve({
        body: v1Ingress,
      }),
  });

  const ingress = await client.readNamespacedIngress('ingress', 'default');
  expect(ingress).toBeDefined();
  expect(ingress?.metadata?.name).toEqual('ingress');
});

// Routes
test('should return empty routes list if there is no active namespace', async () => {
  const client = createTestClient();

  const list = await client.listRoutes();
  expect(list.length).toBe(0);
});

test('should return empty routes list if cannot connect to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listRoutes();
  expect(list.length).toBe(0);
});

test('should return empty routes list if cannot execute call to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedCustomObject: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listRoutes();
  expect(list.length).toBe(0);
});

test('should return route list if connection to cluster is ok', async () => {
  const v1Route: V1Route = {
    apiVersion: 'route.openshift.io/v1',
    kind: 'Route',
    metadata: {
      name: 'route',
      namespace: 'default',
    },
    spec: {
      host: 'host',
      port: {
        targetPort: '80',
      },
      tls: {
        insecureEdgeTerminationPolicy: '',
        termination: '',
      },
      to: {
        kind: '',
        name: '',
        weight: 1,
      },
      wildcardPolicy: '',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedCustomObject: () =>
      Promise.resolve({
        body: [v1Route],
      }),
  });

  const list = await client.listRoutes();
  expect(list.length).toBe(1);
  expect(list[0].metadata?.name).toEqual('route');
});

test('should throw error if cannot call the cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    getNamespacedCustomObject: () => Promise.reject(new Error('K8sError')),
  });

  try {
    await client.readNamespacedRoute('route', 'default');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(err).to.be.a('Error');
    expect(err.message).equal('K8sError');
  }
});

test('should return undefined if route does not exist', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    getNamespacedCustomObject: () => Promise.resolve({}),
  });

  const route = await client.readNamespacedRoute('route', 'default');
  expect(route).not.toBeDefined();
});

test('should return route if it exists', async () => {
  const v1Route: V1Route = {
    apiVersion: 'route.openshift.io/v1',
    kind: 'Route',
    metadata: {
      name: 'route',
      namespace: 'default',
    },
    spec: {
      host: 'host',
      port: {
        targetPort: '80',
      },
      tls: {
        insecureEdgeTerminationPolicy: '',
        termination: '',
      },
      to: {
        kind: '',
        name: '',
        weight: 1,
      },
      wildcardPolicy: '',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    getNamespacedCustomObject: () =>
      Promise.resolve({
        body: v1Route,
      }),
  });

  const route = await client.readNamespacedRoute('route', 'default');
  expect(route).toBeDefined();
  expect(route?.metadata?.name).toEqual('route');
});

test('Expect deleteIngress is not called if there is no active namespace', async () => {
  const client = createTestClient();
  const deleteIngressMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    deleteNamespacedIngress: deleteIngressMock,
  });

  await client.deleteIngress('name');
  expect(deleteIngressMock).not.toBeCalled();
});

test('Expect deleteIngress is not called if there is no active connection', async () => {
  const client = createTestClient('default');
  const deleteIngressMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    deleteNamespacedIngress: deleteIngressMock,
  });

  await client.deleteIngress('name');
  expect(deleteIngressMock).not.toBeCalled();
});

test('Expect deleteIngress to be called if there is active connection', async () => {
  const client = createTestClient('default');
  const deleteIngressMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    deleteNamespacedIngress: deleteIngressMock,
  });

  await client.deleteIngress('name');
  expect(deleteIngressMock).toBeCalled();
});

test('Expect deleteRoute is not called if there is no active namespace', async () => {
  const client = createTestClient();
  const deleteRouteMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    deleteNamespacedCustomObject: deleteRouteMock,
  });

  await client.deleteRoute('name');
  expect(deleteRouteMock).not.toBeCalled();
});

test('Expect deleteRoute is not called if there is no active connection', async () => {
  const client = createTestClient('default');
  const deleteRouteMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    deleteNamespacedCustomObject: deleteRouteMock,
  });

  await client.deleteRoute('name');
  expect(deleteRouteMock).not.toBeCalled();
});

test('Expect deleteRoute to be called if there is active connection', async () => {
  const client = createTestClient('default');
  const deleteRouteMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    deleteNamespacedCustomObject: deleteRouteMock,
  });

  await client.deleteRoute('name');
  expect(deleteRouteMock).toBeCalled();
});

test('should return empty service list if there is no active namespace', async () => {
  const client = createTestClient();

  const list = await client.listServices();
  expect(list.length).toBe(0);
});

test('should return empty service list if cannot connect to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listServices();
  expect(list.length).toBe(0);
});

test('should return empty service list if cannot execute call to cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedService: () => Promise.reject(new Error('K8sError')),
  });

  const list = await client.listServices();
  expect(list.length).toBe(0);
});

test('should return service list if connection to cluster is ok', async () => {
  const v1Service: V1Service = {
    apiVersion: 'k8s.io/v1',
    kind: 'Service',
    metadata: {
      name: 'service',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    listNamespacedService: () =>
      Promise.resolve({
        body: {
          items: [v1Service],
        },
      }),
  });

  const list = await client.listServices();
  expect(list.length).toBe(1);
  expect(list[0].metadata?.name).toEqual('service');
});

test('should throw error if cannot call the cluster', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedService: () => Promise.reject(new Error('K8sError')),
  });

  try {
    await client.readNamespacedService('service', 'default');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(err).to.be.a('Error');
    expect(err.message).equal('K8sError');
  }
});

test('should return undefined if service does not exist', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedService: () => Promise.resolve({}),
  });

  const service = await client.readNamespacedService('service', 'default');
  expect(service).not.toBeDefined();
});

test('should return service if it exists', async () => {
  const v1Service: V1Service = {
    apiVersion: 'k8s.io/v1',
    kind: 'Service',
    metadata: {
      name: 'service',
    },
  };
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    readNamespacedService: () =>
      Promise.resolve({
        body: v1Service,
      }),
  });

  const service = await client.readNamespacedService('service', 'default');
  expect(service).toBeDefined();
  expect(service?.metadata?.name).toEqual('service');
});

test('Expect deleteService is not called if there is no active namespace', async () => {
  const client = createTestClient();
  const deleteServiceMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    deleteNamespacedService: deleteServiceMock,
  });

  await client.deleteService('name');
  expect(deleteServiceMock).not.toBeCalled();
});

test('Expect deleteService is not called if there is no active connection', async () => {
  const client = createTestClient('default');
  const deleteServiceMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    deleteNamespacedService: deleteServiceMock,
  });

  await client.deleteService('name');
  expect(deleteServiceMock).not.toBeCalled();
});

test('Expect deleteService to be called if there is an active connection', async () => {
  const client = createTestClient('default');
  const deleteServiceMock = vi.fn();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.resolve({ body: { gitVersion: 'v1.20.0' } }),
    deleteNamespacedService: deleteServiceMock,
  });

  await client.deleteService('name');
  expect(deleteServiceMock).toBeCalled();
});

// deployment informer
test('Expect deployment startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient();
  await expect(client.startInformer('INGRESS')).rejects.toThrowError('no active namespace');
});

test('Expect deployment startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedDeployment: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(undefined);
  await expect(client.startInformer('DEPLOYMENT')).rejects.toThrowError('error when setting the informer');
});

test('Expect deployment startInformer creates new informer and add it to registry', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedDeployment: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  const id = await client.startInformer('DEPLOYMENT');
  const informerItem = informerManager.getInformerInfo(id);
  expect(informerItem).not.toBeUndefined();
});

test('Expect deployment startInformer updates an existing informer if an id is passed', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedDeployment: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'DEPLOYMENT');
  // start it again and check informer is refreshed
  await client.startInformer('DEPLOYMENT', id);
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

test('Expect deployment refreshInformer should stop and start the informer again', async () => {
  const client = createTestClient('default');
  mockContext();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedDeployment: vi.fn(),
  });
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'DEPLOYMENT');
  // refresh it again and check informer is stopped and restarted
  await client.refreshInformer(id);
  expect(stopInformerMock).toBeCalled();
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

// ingress informer
test('Expect ingress startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient();
  await expect(client.startInformer('INGRESS')).rejects.toThrowError('no active namespace');
});

test('Expect ingress startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(undefined);
  await expect(client.startInformer('INGRESS')).rejects.toThrowError('error when setting the informer');
});

test('Expect ingress startInformer creates new informer and add it to registry', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  const id = await client.startInformer('INGRESS');
  const informerItem = informerManager.getInformerInfo(id);
  expect(informerItem).not.toBeUndefined();
});

test('Expect ingress startInformer updates an existing informer if an id is passed', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'INGRESS');
  // start it again and check informer is refreshed
  await client.startInformer('INGRESS', id);
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

test('Expect ingress refreshInformer should stop and start the informer again', async () => {
  const client = createTestClient('default');
  mockContext();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'INGRESS');
  // refresh it again and check informer is stopped and restarted
  await client.refreshInformer(id);
  expect(stopInformerMock).toBeCalled();
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

// route informer
test('Expect ingress startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient();
  await expect(client.startInformer('INGRESS')).rejects.toThrowError('no active namespace');
});

test('Expect ingress startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(undefined);
  await expect(client.startInformer('INGRESS')).rejects.toThrowError('error when setting the informer');
});

test('Expect ingress startInformer creates new informer and add it to registry', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  const id = await client.startInformer('INGRESS');
  const informerItem = informerManager.getInformerInfo(id);
  expect(informerItem).not.toBeUndefined();
});

test('Expect ingress startInformer updates an existing informer if an id is passed', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'INGRESS');
  // start it again and check informer is refreshed
  await client.startInformer('INGRESS', id);
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

test('Expect ingress refreshInformer should stop and start the informer again', async () => {
  const client = createTestClient('default');
  mockContext();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'INGRESS');
  // refresh it again and check informer is stopped and restarted
  await client.refreshInformer(id);
  expect(stopInformerMock).toBeCalled();
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

// service informer
test('Expect ingress startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient();
  await expect(client.startInformer('INGRESS')).rejects.toThrowError('no active namespace');
});

test('Expect ingress startInformer throws an error if there is no active namespace', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(undefined);
  await expect(client.startInformer('INGRESS')).rejects.toThrowError('error when setting the informer');
});

test('Expect ingress startInformer creates new informer and add it to registry', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  const id = await client.startInformer('INGRESS');
  const informerItem = informerManager.getInformerInfo(id);
  expect(informerItem).not.toBeUndefined();
});

test('Expect ingress startInformer updates an existing informer if an id is passed', async () => {
  const client = createTestClient('default');
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  getContextObjectMock.mockReturnValue(context);
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'INGRESS');
  // start it again and check informer is refreshed
  await client.startInformer('INGRESS', id);
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

test('Expect ingress refreshInformer should stop and start the informer again', async () => {
  const client = createTestClient('default');
  mockContext();
  makeApiClientMock.mockReturnValue({
    getCode: () => Promise.reject(new Error('K8sError')),
    listNamespacedIngress: vi.fn(),
  });
  vi.spyOn(clientNode, 'makeInformer').mockReturnValue(informer);

  // add informer to registry
  const id = informerManager.addInformer(informer, context, 'INGRESS');
  // refresh it again and check informer is stopped and restarted
  await client.refreshInformer(id);
  expect(stopInformerMock).toBeCalled();
  expect(apiSenderSendMock).toBeCalledWith('kubernetes-informer-refresh', id);
});

test('Expect apply with invalid file should error', async () => {
  const client = createTestClient('default');
  try {
    await client.applyResourcesFromFile('default', 'missing-file.yaml');
    throw Error('should never get here');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    expect(err).to.be.a('Error');
    expect(err.message).equal('File missing-file.yaml does not exist');
  }
});

test('Expect apply with empty yaml should return no objects', async () => {
  const client = createTestClient('default');
  vi.spyOn(client, 'loadManifestsFromFile').mockReturnValue(Promise.resolve([]));

  const objects = await client.applyResourcesFromFile('default', 'missing-file.yaml');
  expect(objects).toEqual([]);
});

test('Expect apply should create if object does not exist', async () => {
  const client = createTestClient('default');
  const manifests = { kind: test, metadata: { annotations: test } } as unknown as KubernetesObject;
  const createdObj = { kind: 'created' };
  vi.spyOn(client, 'loadManifestsFromFile').mockReturnValue(Promise.resolve([manifests]));
  makeApiClientMock.mockReturnValue({
    create: vi.fn().mockReturnValue({ body: createdObj }),
  });

  const objects = await client.applyResourcesFromFile('default', 'some-file.yaml');

  expect(objects).toHaveLength(1);
  expect(objects[0]).toEqual(createdObj);
});

test('Expect apply should patch if object exists', async () => {
  const client = createTestClient('default');
  const manifests = { kind: test, metadata: { annotations: test } } as unknown as KubernetesObject;
  const patchedObj = { kind: 'patched' };
  vi.spyOn(client, 'loadManifestsFromFile').mockReturnValue(Promise.resolve([manifests]));
  makeApiClientMock.mockReturnValue({
    read: vi.fn(),
    patch: vi.fn().mockReturnValue({ body: patchedObj }),
  });

  const objects = await client.applyResourcesFromFile('default', 'some-file.yaml');

  expect(objects).toHaveLength(1);
  expect(objects[0]).toEqual(patchedObj);
});
